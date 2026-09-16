import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
// THROWAWAY (stats layout mockup). Delete this import, the constant and the
// ternary below, and the src/mockups folder, once a layout is chosen.
import StatsLayoutMockup from './mockups/StatsLayoutMockup';
//import reportWebVitals from './reportWebVitals';

const root = ReactDOM.createRoot(document.getElementById('root'));

// Mounted only at /stats-mockup, so the real app is untouched at every other
// path. Kept here rather than in a router so no live component had to change.
const showStatsMockup = window.location.pathname.startsWith('/stats-mockup');

root.render(
  <React.StrictMode>
    {showStatsMockup ? <StatsLayoutMockup /> : <App />}
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
//reportWebVitals();
