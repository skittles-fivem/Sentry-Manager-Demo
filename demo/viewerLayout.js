'use strict';

// The Viewer's car-data layout every visitor starts with: the owner's own.
// The manager keeps the stat board per account (web/statDash.js, PUT
// /api/dashboards), and every visitor is the "demo" account, so the demo's
// set-up saves it once through the app's API. A visitor may rearrange it:
// their saves are answered "saved" and forgotten (demo/policy.js,
// QUIET_WRITES), so the next visitor, and every reset, starts from this.
//
// Three 3-in-1 blocks (each signal id as statDash.js names it; the labels are
// what the bar shows), then the List with every stat, "Changing only" ticked;
// °F and mph.

const OWNER_BOARD = () => ({
  boards: [{
    id: 'default',
    name: 'Drive',
    placement: 'below',
    metric: false,
    listPlacement: 'dock',
    blocks: [
      // Battery temp, HV Battery Current, Battery power (computed)
      { type: 'wide', signals: ['calc.battTemp', 'can.SmoothBattCurrent132', 'calc.batteryPower'] },
      // Battery Coolant Temp, 12V Battery Voltage, 12V Battery Current
      { type: 'wide', signals: ['can.VCFRONT_tempCoolantBatInlet', 'can.v12vBattVoltage261', 'can.v12vBattCurrent261'] },
      // Outside Temperature, Cabin Temperature, Steering
      { type: 'wide', signals: ['can.VCFRONT_tempAmbientFiltered', 'can.VCRIGHT_hvacCabinTempEst', 'dash.steering'] },
      // the "Every stat" List, changing ones only
      { type: 'list', signals: [], q: '', changing: true }
    ]
  }],
  active: 'default'
});

/** Saves the owner's layout for the demo account; a manager without stat boards (404) is skipped. */
async function seedViewerLayout(api, log = () => {}) {
  try {
    await api('PUT', '/api/dashboards', OWNER_BOARD());
    log('Viewer car-data layout set (the owner\'s)');
    return true;
  } catch (err) {
    if (err.status === 404) log('Viewer car-data layout: this manager has no stat boards; left as it is');
    else log(`Viewer car-data layout not set: ${err.message}`);
    return false;
  }
}

module.exports = { OWNER_BOARD, seedViewerLayout };
