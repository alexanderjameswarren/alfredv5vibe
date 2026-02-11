/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: '#16A085',  // Darker teal for buttons
          hover: '#138D75',    // Even darker on hover
          light: '#a2d8c8',    // Your soft teal for accents
          bg: '#F8FFFE',       // Subtle teal-tinted backgrounds
        },
        success: '#27AE60',
        danger: '#E74C3C',
        dark: '#2C3E50',       // Dark blue-gray for text
      },
    },
  },
  plugins: [],
}