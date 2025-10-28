const isDev = process.env.DEV === 'true';
const email = process.env.EDF_USERNAME;

const log = (...args) => {
  return console.log(`[${(new Date()).toISOString()}]`, ...args);
}

const addToState = (name, state, attributes) => {
  if (isDev) {
    return log('[Dev] Add to state', name, state, attributes);
  } else {
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
  }
};

const sleep = (ms) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

const getData = async () => {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');

  puppeteer.use(StealthPlugin());

  const browser = await puppeteer.launch({
    headless: isDev ? false : 'new',
    executablePath: isDev ?
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' :
      '/usr/bin/chromium-browser',
    args: isDev ? [] : [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--headless',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
  });

  // Open new tab
  const page = await browser.newPage();

  page.on("framenavigated", frame => {
    const url = frame.url(); // the new url
    log('Frame navigated', url);
  });

  page.setDefaultNavigationTimeout(5 * 60 * 1000); // 5 minutes

  await page.setRequestInterception(true);

  page.on('request', req => {
    if (req.url().startsWith('https://track.adform.net')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Set viewport
  await page.setViewport({
    width: 1904,
    height: 1012,
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

  await page.goto('https://particulier.edf.fr', {
    waitUntil: 'networkidle0',
  });

  // Accept cookies
  await page.waitForSelector('button[title="Accepter"]');
  if (await page.$('button[title="Accepter"]') !== null) {
    await page.click('button[title="Accepter"]');
  }

  // Load login page (redirection)
  await page.goto('https://suiviconso.edf.fr/comprendre', {
    waitUntil: 'networkidle0',
  });

  // Login steps

  // Click on email
  await page.waitForSelector('#email');
  await page.click('#email');

  // Type email
  await page.keyboard.type(email);
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
    await sleep(1000);

    if (await page.$('#hotpcust3-next-button') !== null) {
      await page.click('#hotpcust3-next-button'); // "Suivant"
    } else {
      await page.evaluate(() => {
        return sendCode();
      });
    }

    log('Waiting for code to be sent by email...');

    if (isDev) {
      // Wait 20 seconds for code to be sent by email (manually set code)
      log('Go get the code from email. 📧 (30 sec.)');
      await sleep(10000);

      log('Go get the code from email. 📧 (20 sec.)');
      await sleep(10000);

      log('Go get the code from email. 📧 (10 sec.)');
      await sleep(5000);

      log('Go get the code from email. 📧 (5 sec.)');
      await sleep(5000);
    } else {
      const emptyPage = await browser.newPage();
      // Wait 60 seconds for code to be sent by email
      await sleep(60000);

      // Close tab
      await emptyPage.close();

      await page.mouse.move(Math.random() * 100, Math.random() * 100);
      await page.mouse.down();
      await page.mouse.move(Math.random() * 100 + 10, Math.random() * 100 + 10);
      await page.mouse.up();

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
      await page.click('#label-code-seizure__field');
      await page.keyboard.type(edfCode);

      log('Code typed');
    }

    // Click on "Suivant"
    await page.click('#hotpcust4-next-button');

    // Enter
    log('Press Enter');
    await page.keyboard.press('Enter');

    log('Code sent to EDF');

    // Wait for page to load
    await sleep(20000);

    await page.goto('https://suiviconso.edf.fr/comprendre');
  }

  // Click on button if session expired
  if (page.url() === 'https://suiviconso.edf.fr/session-expiree') {
    await page.click('button');
  }

  await page.waitForNavigation({
    waitUntil: 'networkidle0',
  });

  if (page.url().includes('sso/XUI/#login')) {
    log('Login failed');
    await browser.close();
    return;
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

  // Click on button
  log('Click on JOUR button', page.url());
  await page.click('button[aria-label="Accéder à la vue JOUR"]');
  await sleep(2000);

  log('Click on MOIS button', page.url());
  await page.click('button[aria-label="Accéder à la vue MOIS"]');
  await sleep(2000);

  log('Click on ANNÉE button', page.url());
  await page.click('button[aria-label="Accéder à la vue ANNÉE"]');
  await sleep(2000);

  log('Click on JOUR button', page.url());
  await page.click('button[aria-label="Accéder à la vue JOUR"]');
  await sleep(2000);

  const json = await getDataFromSessionStorage([
    'datacache:elec-consumptions',
    'DAYS'
  ]);

  if (json && json.step === 'P1D') {
    // Filter by REAL and COMPLETE
    const consumptions = json.consumptions.filter((consumption) => {
      // return consumption.nature === 'REAL' && consumption.status === 'COMPLETE';
      return true; // We keep all data
    });

    // Sort by startTime (asc)
    consumptions.sort((a, b) => {
      return new Date(a.period.startTime) - new Date(b.period.startTime);
    });

    // Get last consumption
    const lastConsumption = consumptions[consumptions.length - 1];
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
        // Chart.js labels and datasets attributes
        chart_datasets: [
          // kWh
          {
            type: 'line',
            label: 'Electricity consumption',
            data: consumptions.map(stat => {
              return {
                x: stat.period.startTime.substring(0, 10), // YYYY-MM-DD
                y: stat.energyMeter.total.toFixed(3), // kWh
              };
            }),
          },
          // Euros
          {
            type: 'bar',
            label: 'Electricity cost',
            data: consumptions.map(stat => {
              return {
                x: stat.period.startTime.substring(0, 10), // YYYY-MM-DD
                y: stat.cost.total.toFixed(2), // €
              };
            }),
          },
        ],
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

  log('Click on JOUR button', page.url());
  await page.click('button[aria-label="Accéder à la vue JOUR"]');
  await sleep(2000);

  log('Click on ANNÉE button', page.url());
  await page.click('button[aria-label="Accéder à la vue ANNÉE"]');
  await sleep(2000);

  log('Click on MOIS button', page.url());
  await page.click('button[aria-label="Accéder à la vue MOIS"]');
  await sleep(2000);

  log('Click on JOUR button', page.url());
  await page.click('button[aria-label="Accéder à la vue JOUR"]');
  await sleep(2000);

  const jsonGas = await getDataFromSessionStorage([
    'datacache:smart-daily-gas-consumptions'
  ]);

  if (jsonGas && jsonGas.length > 0) {
    // Sort by day (asc)
    jsonGas.sort((a, b) => {
      return new Date(a.day) - new Date(b.day);
    });

    const lastGasConsumption = jsonGas[jsonGas.length - 1];
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
        // Chart.js labels and datasets attributes
        chart_datasets: [
          // kWh
          {
            type: 'line',
            label: 'Gas consumption',
            data: jsonGas.map(stat => {
              return {
                x: stat.day, // YYYY-MM-DD
                y: stat.consumption.energy.toFixed(3), // kWh
              };
            }),
          },
          // Euros
          {
            type: 'bar',
            label: 'Gas cost',
            data: jsonGas.map(stat => {
              return {
                x: stat.day, // YYYY-MM-DD
                y: stat.totalCost.toFixed(2), // €
              };
            }),
          },
        ],
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

getData();
