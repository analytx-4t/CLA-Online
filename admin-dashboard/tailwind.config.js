/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#0F9D58',
          dark: '#111111',
          light: '#FFFFFF',
        },
      },
      boxShadow: {
        soft: '0 10px 40px rgba(17, 17, 17, 0.12)',
      },
    },
  },
  plugins: [],
};
