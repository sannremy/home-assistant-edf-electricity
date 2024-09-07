const CronJob = require('cron').CronJob;
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const log = (...args) => {
  return console.log(`[${(new Date()).toISOString()}]`, ...args);
}

const addToState = (name, state, attributes) => {
  return fetch(`http://supervisor/core/api/states/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.SUPERVISOR_TOKEN,
    },
    body: JSON.stringify({
      state,
      attributes,
    }),
  });
};

const getTempoData = async (browser) => {
  // Open new tab
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(5 * 60 * 1000); // 5 minutes

  // Set viewport
  await page.setViewport({
    width: 1168,
    height: 687,
  });

  const getContentFromAPI = async (url) => {
    return await new Promise(async resolve => {
      log('Set event on response for API call', page.url());
      page.on('response', async response => {
        if (
          response.request().resourceType() === 'xhr' &&
          response.ok() &&
          response.url().includes(url)
        ) {
          log('Get: ' + response.url());
          const json = await response.json();

          if (json.content) {
            return resolve(json.content);
          }
        }
      });
    });
  };

  // Get tempo JSON data
  const tempoPromise = getContentFromAPI('https://api-commerce.edf.fr/commerce/activet/v1/calendrier-jours-effacement');

  // Get remaining tempo days
  const remainingTempoDaysPromise = getContentFromAPI('https://api-commerce.edf.fr/commerce/activet/v1/saisons/search');

  // Tempo page
  await page.goto('https://particulier.edf.fr/fr/accueil/gestion-contrat/options/tempo.html', {
    waitUntil: 'networkidle0',
  });

  const tempoJson = await tempoPromise;

  const date = new Date();
  const dateTempoToday = date.toISOString().split('T')[0];

  const dateTomorrow = new Date();
  dateTomorrow.setDate(dateTomorrow.getDate() + 1);
  const dateTempoTomorrow = dateTomorrow.toISOString().split('T')[0];

  await addToState(
    'sensor.tempo_today',
    tempoJson.options.calendrier.find((calendrier) => { return calendrier.dateApplication === dateTempoToday; }).statut,
    {
      friendly_name: 'EDF - Tempo today',
      date: tempoJson.dateHeureTraitementActivET,
    }
  );

  await addToState(
    'sensor.tempo_tomorrow',
    tempoJson.options.calendrier.find((calendrier) => { return calendrier.dateApplication === dateTempoTomorrow; }).statut,
    {
      friendly_name: 'EDF - Tempo tomorrow',
      date: tempoJson.dateHeureTraitementActivET,
    }
  );

  const remainingTempoDaysJson = await remainingTempoDaysPromise;

  remainingTempoDaysJson.content.forEach(async (color) => {
    await addToState(
      `sensor.remaining_${color.typeJourEff.toLowerCase().replace('tempo_', '')}_days`,
      color.nombreJours - color.nombreJoursTires,
      color
    );
  });
};

const getData = async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/chromium-browser',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--headless',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
  });

  // Get tempo data
  try {
    await getTempoData(browser);
  } catch (e) {
    log('Error getting tempo data', e);
  }

  // Open new tab
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(5 * 60 * 1000); // 5 minutes

  // Set viewport
  await page.setViewport({
    width: 1168,
    height: 687,
  });

  // Load login page (redirection)
  await page.goto('https://suiviconso.edf.fr/comprendre', {
    waitUntil: 'networkidle0',
  });

  // Accept cookies
  await page.waitForSelector('button[title="Accepter"]');
  if (await page.$('button[title="Accepter"]') !== null) {
    await page.click('button[title="Accepter"]');
  }

  // Login steps

  // Click on email
  await page.waitForSelector('#email');
  await page.click('#email');

  // Type email
  await page.keyboard.type(process.env.EDF_USERNAME);
  await page.keyboard.press('Enter');

  // Wait for selector to appear
  const emailRadioSelector = '#callback_0_1';
  await page.waitForSelector(emailRadioSelector, {
    timeout: 10000,
  });

  // Select "email" to send MFA code
  if (await page.$(emailRadioSelector) !== null) {
    // Select radio button
    await page.click(emailRadioSelector); // "Email"
    await page.click('#hotpcust3-next-button'); // "Suivant"

    log('Waiting for code to be sent by email...');

    // Wait 30 seconds for code to be sent by email
    await new Promise(r => setTimeout(r, 30000));

    log('Getting code from Home Assistant...');

    // Get the code from Home Assistant
    const sensorReq = await fetch('http://supervisor/core/api/states/sensor.edf_code', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.SUPERVISOR_TOKEN,
      },
    });

    const sensorJson = await sensorReq.json();
    const edfCode = sensorJson.state;

    log('Code: ' + edfCode);

    // Type code
    await page.click('#code-seizure__field');
    await page.keyboard.type(edfCode);

    log('Code typed');

    // Click on "Suivant"
    await page.click('#hotpcust4-next-button');

    log('Code sent to EDF');

    // Wait for page to load
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
    });
  }

  // Click on button if session expired
  if (page.url() === 'https://suiviconso.edf.fr/session-expiree') {
    await page.click('button');

    await page.waitForNavigation({
      waitUntil: 'networkidle0',
    });
  }

  log('Scroll to bottom of page', page.url());

  // Upstream client's log messages to Node console
  // page.on('console', async (msg) => {
  //   const msgArgs = msg.args();
  //   for (let i = 0; i < msgArgs.length; ++i) {
  //     log(`[Client]`, await msgArgs[i].jsonValue());
  //   }
  // });

  // Scroll to bottom of page
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      // console.log('Start scrolling');
      const timer = setInterval(() => {
        window.scrollBy(0, 300);
        // console.log('Scrolling...', document.body.scrollHeight);

        if (document.querySelector('button[aria-label="Accéder à la vue JOUR"]')) {
          // console.log('Stop scrolling');
          clearInterval(timer);
          resolve();
        }
      }, 1000);
    });
  });

  log('----- ELECTRICITY -----');

  const json = await new Promise(async resolve => {
    log('Set event on response for API call', page.url());
    page.on('response', async response => {
      if (
        response.request().resourceType() === 'xhr' &&
        response.ok() &&
        response.url().includes('https://suiviconso.edf.fr/api/v2/sites/-/consumptions')
      ) {
        log('Get: ' + response.url());
        const json = await response.json();

        if (json.step === 'P1D') {
          return resolve(json);
        }
      }
    });

    log('Click on JOUR button', page.url());

    // Click on button
    await page.click('button[aria-label="Accéder à la vue JOUR"]');
  });

  // Filter by REAL and COMPLETE
  const consumptions = json.consumptions.filter((consumption) => {
    return consumption.nature === 'REAL' && consumption.status === 'COMPLETE';
  });

  // Sort by startTime (desc)
  consumptions.sort((a, b) => {
    return new Date(b.period.startTime) - new Date(a.period.startTime);
  });

  // Get last consumption
  const lastConsumption = consumptions[0];
  const electricityDate = new Date(lastConsumption.period.startTime);
  electricityDate.setHours(0, 0, 0, 0);

  // Add energy meter to state
  await addToState(
    'sensor.edf_electricity_consumption_kwh',
    lastConsumption.energyMeter.total.toFixed(3),
    {
      unit_of_measurement: 'kWh',
      friendly_name: 'EDF - Electricity consumption',
      icon: 'mdi:power',
      device_class: 'energy',
      date: electricityDate.toISOString(),
      state_class: 'measurement',
    }
  );

  // Add cost to state
  await addToState(
    'sensor.edf_electricity_consumption_cost',
    lastConsumption.cost.total.toFixed(2),
    {
      unit_of_measurement: '€',
      friendly_name: 'EDF - Electricity consumption',
      icon: 'mdi:currency-eur',
      device_class: 'monetary',
      date: electricityDate.toISOString(),
      state_class: 'total_increasing',
    }
  );

  // ----------------------------- GAS -----------------------------
  // ----------------------------- GAS -----------------------------
  // ----------------------------- GAS -----------------------------
  // ----------------------------- GAS -----------------------------

  log('----- GAS -----');

  // Check for gas
  const jsonGas = await new Promise(async resolve => {
    log('Set event on response for API call', page.url());
    page.on('response', async response => {
      if (
        response.request().resourceType() === 'xhr' &&
        response.ok() &&
        response.url().includes('https://suiviconso.edf.fr/api/v1/sites/-/smart-daily-gas-consumptions')
      ) {
        log('Get: ' + response.url());
        const json = await response.json();
        return resolve(json);
      }
    });

    log('Click on GAS button', page.url());

    // Click on button
    await page.click('label[for="switch-fluid-radio-gaz"]');
  });

  if (jsonGas.length > 0) {
    // Sort by day (desc)
    jsonGas.sort((a, b) => {
      return new Date(b.day) - new Date(a.day);
    });

    const lastGasConsumption = jsonGas[0];
    const gasDate = new Date(lastGasConsumption.day);
    gasDate.setHours(0, 0, 0, 0);

    // Add energy meter to state
    await addToState(
      'sensor.edf_gas_consumption_kwh',
      lastGasConsumption.consumption.energy.toFixed(3),
      {
        unit_of_measurement: 'kWh',
        friendly_name: 'EDF - Gas consumption',
        icon: 'mdi:power',
        device_class: 'energy',
        date: gasDate.toISOString(),
        state_class: 'measurement',
      }
    );

    // Add cost to state
    await addToState(
      'sensor.edf_gas_consumption_cost',
      lastGasConsumption.totalCost.toFixed(2),
      {
        unit_of_measurement: '€',
        friendly_name: 'EDF - Gas consumption',
        icon: 'mdi:currency-eur',
        device_class: 'monetary',
        date: gasDate.toISOString(),
        state_class: 'total_increasing',
      }
    );
  }

  // Close browser
  log('Close browser');
  await browser.close();
};

const job = new CronJob(
  `0 ${process.env.EDF_CRON}`,
  function () { // onTick
    getData();
  },
  null,
  true, // Start the job right now
  'Europe/Paris', // Timezone
  null, // Context
  true // Run the job
);
