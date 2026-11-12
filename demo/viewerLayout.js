'use strict';

// The Viewer's car-data layout every visitor starts with: the owner's own.
// The manager keeps the stat board per account (web/statDash.js, PUT
// /api/dashboards), and every visitor is the "demo" account, so the demo's
// set-up saves it once through the app's API. A visitor may rearrange it:
// their saves are answered "saved" and forgotten (demo/policy.js,
// QUIET_WRITES), so the next visitor, and every reset, starts from this.
//
// Three 3-in-1 blocks (each signal id as statDash.js names it; the labels are
// what the bar shows); °F and mph. The "Every stat" List is not in it: docked,
// it took most of the Original interface's Viewer (which does not scroll) and
// squashed the cameras, so the bar rose onto them under the Clips panel and
// the map. A visitor can still add the List with Customize.

const OWNER_BOARD = () => ({
  boards: [{
    id: 'default',
    name: 'Drive',
    placement: 'below',
    metric: false,
    blocks: [
      // Battery temp, HV Battery Current, Battery power (computed)
      { type: 'wide', signals: ['calc.battTemp', 'can.SmoothBattCurrent132', 'calc.batteryPower'] },
      // Battery Coolant Temp, 12V Battery Voltage, 12V system current (the DC-DC's output: what the
      // 12V side draws, 20-80 A driving; the 12V battery's own current is about 0 then)
      { type: 'wide', signals: ['can.VCFRONT_tempCoolantBatInlet', 'can.v12vBattVoltage261', 'can.PCS_dcdcLvOutputCurrent'] },
      // Outside Temperature, Cabin Temperature, Steering
      { type: 'wide', signals: ['can.VCFRONT_tempAmbientFiltered', 'can.VCRIGHT_hvacCabinTempEst', 'dash.steering'] }
    ]
  }],
  active: 'default'
});

/** Saves the owner's layout for the demo account; a manager without stat boards (404) is skipped. */
async function seedViewerLayout(api, log = () => {}) {
  // the car-data bar is a server setting, off on a fresh install (the demo starts
  // fresh every time): on, for every visitor's Viewer in every interface
  try {
    await api('POST', '/api/can/viewer-car-data', { enabled: true });
    log('Viewer car data on');
  } catch (err) {
    // a manager from before the setting has the bar on already
    if (err.status !== 404) log(`Viewer car data not turned on: ${err.message}`);
  }
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
