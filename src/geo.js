// Approximate station / depot positions (lat, lng) for drawing the network.
// World units are kilometres: +x east, -z north, centred on the island.
export const STATIONS = {
  // East-West Line (+ Changi Airport branch)
  TLK: [1.3409, 103.6370], TWR: [1.3302, 103.6397], TCR: [1.3210, 103.6490], GCL: [1.3195, 103.6606],
  JKN: [1.3277, 103.6783], PNR: [1.3376, 103.6974], BNL: [1.3386, 103.7060], LKS: [1.3442, 103.7210],
  CNG: [1.3423, 103.7326], JUR: [1.3331, 103.7422], CLE: [1.3151, 103.7652], DVR: [1.3114, 103.7786],
  BNV: [1.3072, 103.7900], COM: [1.3025, 103.7983], QUE: [1.2945, 103.8060], RDH: [1.2896, 103.8168],
  TIB: [1.2862, 103.8270], OTP: [1.2803, 103.8395], TPG: [1.2764, 103.8457], RFP: [1.2840, 103.8515],
  CTH: [1.2931, 103.8520], BGS: [1.3009, 103.8559], LVR: [1.3073, 103.8630], KAL: [1.3114, 103.8714],
  ALJ: [1.3164, 103.8829], PYL: [1.3177, 103.8927], EUN: [1.3198, 103.9030], KEM: [1.3210, 103.9130],
  BDK: [1.3240, 103.9300], TNM: [1.3274, 103.9465], SIM: [1.3432, 103.9533], TAM: [1.3544, 103.9454],
  PSR: [1.3730, 103.9493], XPO: [1.3345, 103.9616], CGA: [1.3574, 103.9884],
  // North-South Line
  BBT: [1.3490, 103.7496], BGB: [1.3587, 103.7518], CCK: [1.3854, 103.7443], YWT: [1.3970, 103.7474],
  KRJ: [1.4252, 103.7620], MSL: [1.4326, 103.7741], WDL: [1.4370, 103.7865], ADM: [1.4406, 103.8010],
  SBW: [1.4491, 103.8201], CBR: [1.4430, 103.8297], YIS: [1.4295, 103.8350], KTB: [1.4174, 103.8330],
  YCK: [1.3817, 103.8449], AMK: [1.3700, 103.8495], BSH: [1.3510, 103.8485], BDL: [1.3404, 103.8470],
  TAP: [1.3327, 103.8474], NOV: [1.3203, 103.8438], NEW: [1.3129, 103.8381], ORC: [1.3043, 103.8320],
  SOM: [1.3006, 103.8390], DBG: [1.2990, 103.8455], MRB: [1.2761, 103.8546], MSP: [1.2712, 103.8633],
};
export const DEPOT_POS = {
  ECID: [1.3395, 103.9745], TWD: [1.3470, 103.6300], UPD: [1.3190, 103.7560], BSD: [1.3585, 103.8420],
};
export const LINE_COLORS = {
  EW: { base: 0x00953b, glow: 0x35e27a, css: '#00953b', cssGlow: '#35e27a' },
  NS: { base: 0xd42e12, glow: 0xff5a36, css: '#d42e12', cssGlow: '#ff5a36' },
};

const LAT0 = 1.352, LNG0 = 103.82;
// The map is stretched by MAP_SCALE so stations get room to breathe (markers keep their size).
export const MAP_SCALE = 1.8;
export function toWorld([lat, lng]){
  return { x: (lng - LNG0) * 111.32 * MAP_SCALE, z: -(lat - LAT0) * 110.57 * MAP_SCALE };
}
