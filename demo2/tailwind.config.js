// [xihanzu-NR]
export default {
  // Scan the .hsx sources directly: the generated .tsx never touches disk in
  // dev, so Tailwind would otherwise see no class names at all.
  content: ['./index.html', './src/**/*.{tsx,ts,hsx}'],
  theme: { extend: {} },
  plugins: [],
}
