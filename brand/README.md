# Brand source

`logo.png` is the master artwork, 1536×1024 on a dark ground.

It lives here rather than in `public/` because everything under `public/` is
deployed as a static asset, and a 1.1 MB file nothing links to is 1.1 MB of
dead weight in the bundle. The icons that *are* served are generated from it:

    public/icons/icon-192.png            centre square, 192
    public/icons/icon-512.png            centre square, 512
    public/icons/icon-maskable-512.png   centre square, 512, inset 10% for the safe zone
    public/icons/apple-touch-icon.png    centre square, 180

Small sizes do not use this file. At 26px in the header and 16px in a browser
tab the window chrome and the camera badge are mud, so those use the compact
mark instead — `public/icons/favicon.svg` and `src/components/Mark.astro`,
which keep the capture brackets and a lens.
