/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Primary palette (Teal family)
        primary: {
          DEFAULT: '#16A085',    // Main teal - buttons, actions
          hover: '#138D75',      // Darker on hover
          light: '#a2d8c8',      // Soft teal - backgrounds, accents
          bg: '#F8FFFE',         // Subtle teal tint for page background
          dark: '#0E6655',       // Even darker for special emphasis
        },
        
        // Semantic colors
success: {
  DEFAULT: '#4DB6AC',    // Soft seafoam
  hover: '#26A69A',      // Slightly darker
  light: '#B2DFDB',      // Light seafoam
},
        danger: {
          DEFAULT: '#E74C3C',    // Delete, cancel, error
          hover: '#C0392B',
          light: '#FADBD8',      // Light error background
        },
warning: {
  DEFAULT: '#95A5A6',    // Soft gray
  hover: '#7F8C8D',      // Slightly darker gray
  light: '#ECF0F1',      // Very light gray background
},
        
        // Neutral colors (text)
        dark: '#2C3E50',         // Primary text color (replaces black)
        muted: '#7F8C8D',        // Secondary text, less important
        
        // Keep Tailwind's gray scale
        // gray-50 through gray-900 still available
      },
    },
  },
  plugins: [
    function ({ addUtilities }) {
      addUtilities({
        '.scrollbar-hide': {
          '-ms-overflow-style': 'none',
          'scrollbar-width': 'none',
          '&::-webkit-scrollbar': {
            display: 'none',
          },
        },
      });
    },
  ],
}