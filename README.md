# Thomas the Tracking Engine

Where every EWL and NSL train is **scheduled** to be right now, on a live 3D map,
built from the OCC timetable reports. Not live tracking: delays and service changes aren't known.

- `index.html` + `app.js` — the 3D Liquid Glass view (three.js). `app.js` is built from `src/`.
- `classic.html` — the simple text view.
- `data/*.enc` — timetables, encrypted (AES-256-GCM, key from PBKDF2-SHA256). The site asks for the
  password once per device.

## Build

```sh
npm install
npm run build      # bundles src/ -> app.js
```

`src/timetable.js` holds the timetable logic (decryption, trip expansion, position at a time),
`src/scene.js` the three.js scene, `src/geo.js` approximate station coordinates, and `src/app.js` the UI.
