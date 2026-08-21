import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Alfred from './Alfred';
import OAuthConsent from './OAuthConsent';

// Step 2 of docs/technical-spec-navigation-urls.md: mount the router and
// change nothing else. This replaces the hard-coded
// `window.location.pathname === '/oauth/consent'` check with two routes that
// dispatch identically.
//
// The catch-all is deliberate and load-bearing. Because `path="*"` matches
// every non-consent path, React sees the same <Alfred /> element in the same
// tree position on every navigation, so Alfred never unmounts and keeps all
// of its state — including the `view` useState it still owns at this step.
// Alfred does not read the URL yet; that is Step 4's bridge.
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/oauth/consent" element={<OAuthConsent />} />
        <Route path="*" element={<Alfred />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
