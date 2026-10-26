/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: { violet: { 500: '#8670e5', 600: '#7862db' } },
      fontFamily: { sans: ['Inter', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'] },
    },
  },
  plugins: [],
};
