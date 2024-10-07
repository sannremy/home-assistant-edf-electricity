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

const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  // Open new tab
  const page = await browser.newPage();

  page.setDefaultNavigationTimeout(5 * 60 * 1000); // 5 minutes

  // Set viewport
  await page.setViewport({
    width: 1168,
    height: 687,
  });

  const getDataFromSessionStorage = async (keyPatterns) => {
    return await page.evaluate((keyPatterns) => {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        let foundAllPatterns = false;
        for (const keyPattern of keyPatterns) {
          if (key.includes(keyPattern)) {
            foundAllPatterns = true;
          } else {
            foundAllPatterns = false;
            break;
          }
        }
        // console.log(foundAllPatterns, key);
        if (foundAllPatterns) {
          console.log('Found key', key);
          return JSON.parse(sessionStorage.getItem(key)).value?.data || null;
        }
      }

      return null;
    }, keyPatterns);
  };

  // const getDataFromAPI = async (url) => {
  //   return await new Promise(async resolve => {
  //     page.on('response', async response => {
  //       if (
  //         response.request().resourceType() === 'xhr' &&
  //         response.ok() &&
  //         response.url().includes(url)
  //       ) {
  //         log('Get: ' + response.url());
  //         const json = await response.json();
  //         return resolve(json);
  //       }
  //     });
  //   });
  // };

  // Clear session storage
  // log('Clear session storage');
  // await page.evaluate(() => {
  //   sessionStorage.clear();
  // });

  // const jsonPromise = getDataFromAPI('https://suiviconso.edf.fr/api/v2/sites/-/consumptions');
  // const jsonGasPromise = getDataFromAPI('https://suiviconso.edf.fr/api/v1/sites/-/smart-daily-gas-consumptions');

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

    // Wait 10 seconds for code to be sent by email
    await sleep(10000);

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
    // await page.click('#hotpcust4-next-button');

    // Enter
    await page.keyboard.press('Enter');

    log('Code sent to EDF');

    // Wait for page to load
    try {
      await page.waitForNavigation({
        waitUntil: 'networkidle0',
      });
    } catch (e) {
      log('Error while waiting for navigation', e);

      // Close browser and return if error (try again later)
      log('Close browser');
      await browser.close();
      return;
    }
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
  page.on('console', async (msg) => {
    const msgArgs = msg.args();
    for (let i = 0; i < msgArgs.length; ++i) {
      log(`[Client]`, await msgArgs[i].jsonValue());
    }
  });

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

  log('Click on JOUR button', page.url());

  // Click on button
  await page.click('button[aria-label="Accéder à la vue JOUR"]');
  await sleep(5000);

  await page.click('button[aria-label="Accéder à la vue MOIS"]');
  await sleep(5000);

  await page.click('button[aria-label="Accéder à la vue ANNÉE"]');
  await sleep(5000);

  const json = await getDataFromSessionStorage([
    'datacache:elec-consumptions',
    'DAYS'
  ]);

  if (json && json.step === 'P1D') {
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
  } else {
    log('Electricity data not available for today');
  }

  // ----------------------------- GAS -----------------------------

  log('----- GAS -----');

  log('Click on GAS button', page.url());

  // Click on button
  await page.click('label[for="switch-fluid-radio-gaz"]');
  await sleep(5000);

  await page.click('button[aria-label="Accéder à la vue ANNÉE"]');
  await sleep(5000);

  await page.click('button[aria-label="Accéder à la vue MOIS"]');
  await sleep(5000);

  await page.click('button[aria-label="Accéder à la vue JOUR"]');
  await sleep(5000);

  const jsonGas = await getDataFromSessionStorage([
    'datacache:smart-daily-gas-consumptions'
  ]);

  if (jsonGas && jsonGas.length > 0) {
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
  } else {
    log('Gas data not available for today');
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
