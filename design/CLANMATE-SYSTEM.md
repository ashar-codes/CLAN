# CLANmate system

A CLANmate is a pure function of a small spec; the same spec renders as SVG (`@clan/design` `CLANmate`) and as a 3D figure
(`@clan/world` `Mate3D`).

```ts
type CLANmateSpec = {
  skin; hair: 'crop'|'bun'|'curls'|'long'|'buzz'|'bob'; hairColor;
  top: 'hoodie'|'tee'|'jacket'|'sweater'; topColor; bottom: 'jeans'|'skirt'|'shorts'|'trousers'; bottomColor;
  shoes: 'sneakers'|'boots'; shoeColor; accessory: 'glasses'|'headphones'|'cap'|'scarf'|null; backpack: colour|null;
}
```

Layers, back to front: shadow → backpack → legs → bottom → shoes → neck → top + arms → hands → head → hair → face → accessory;
the Beacon sits outside the figure at shoulder height.

* People choose their own look; no photos, no face detection, no inference from images or names.
* Faces are two dots and a blush: friendly, non-identifying, no expressions to misread.
* Adding a part = one entry in the part table (SVG path) + one primitive in `Mate3D`; specs stay backwards compatible
  (unknown parts fall back to defaults).
* Skin tones are free colour values, never a fixed short list.
