import Alfred from './Alfred';
import OAuthConsent from './OAuthConsent';

function App() {
  if (window.location.pathname === '/oauth/consent') {
    return <OAuthConsent />;
  }

  return <Alfred />;
}

export default App;