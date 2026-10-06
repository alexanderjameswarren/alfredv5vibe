import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

const EXPIRED_MESSAGE =
  'This connection request has expired or was already used. Go back to Claude and click Connect again.';

// getAuthorizationDetails returns either details (consent needed) or
// { redirect_url } when this client was already approved and Supabase auto-approved.
function alreadyConsentedUrl(data) {
  return data && !('authorization_id' in data) && data.redirect_url ? data.redirect_url : null;
}

function isNoLongerPending(err) {
  return /no longer pending/i.test(err?.message || '');
}

export default function OAuthConsent() {
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState(null);
  const [authDetails, setAuthDetails] = useState(null);
  const [user, setUser] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const authorizationId = params.get('authorization_id');

  function redirect(url) {
    setRedirecting(true);
    window.location.replace(url);
  }

  useEffect(() => {
    async function init() {
      // Check if user is logged in
      const { data: { user: currentUser } } = await supabase.auth.getUser();

      if (!currentUser) {
        // Redirect to login, preserving the authorization_id
        await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: window.location.href,
          },
        });
        return;
      }

      setUser(currentUser);

      if (!authorizationId) {
        setError('Missing authorization_id parameter.');
        setLoading(false);
        return;
      }

      try {
        const { data, error: fetchError } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
        if (fetchError) {
          setError(fetchError.message || 'Failed to load authorization details.');
        } else if (alreadyConsentedUrl(data)) {
          redirect(alreadyConsentedUrl(data));
          return;
        } else {
          setAuthDetails(data);
        }
      } catch (e) {
        setError('Failed to load authorization details: ' + String(e));
      }

      setLoading(false);
    }

    init();
  }, [authorizationId]);

  // The request was approved elsewhere (or auto-approved); follow its redirect if Supabase still has one.
  async function recoverFromNoLongerPending() {
    try {
      const { data } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      const url = alreadyConsentedUrl(data);
      if (url) {
        redirect(url);
        return;
      }
    } catch (e) {
      // fall through to the expired card
    }
    setError(EXPIRED_MESSAGE);
    setSubmitting(false);
  }

  async function decide(action) {
    setSubmitting(true);
    const method = action === 'approve' ? 'approveAuthorization' : 'denyAuthorization';
    try {
      const { data, error: decideError } = await supabase.auth.oauth[method](authorizationId, { skipBrowserRedirect: true });
      if (decideError) {
        if (isNoLongerPending(decideError)) {
          await recoverFromNoLongerPending();
          return;
        }
        setError(decideError.message || `Failed to ${action} authorization.`);
        setSubmitting(false);
        return;
      }
      if (data?.redirect_url) {
        redirect(data.redirect_url);
      } else {
        setError(`No redirect returned after ${action}.`);
        setSubmitting(false);
      }
    } catch (e) {
      setError(`Failed to ${action}: ` + String(e));
      setSubmitting(false);
    }
  }

  // Loading / redirecting state
  if (loading || redirecting) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-primary-bg">
        <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-md text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-dark font-medium">
            {redirecting ? 'Redirecting…' : 'Loading authorization details...'}
          </p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-primary-bg">
        <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-md">
          <h1 className="text-2xl font-bold text-dark mb-2 text-center">Alfred</h1>
          <p className="text-sm text-muted text-center mb-6">Authorization Error</p>
          <div className="mb-4 p-3 bg-danger-light border border-danger text-danger rounded-lg text-sm">
            {error}
          </div>
          <button
            onClick={() => window.location.href = '/'}
            className="w-full px-4 py-3 bg-gray-200 text-dark rounded-lg hover:bg-gray-300 transition-colors"
          >
            Return to Alfred
          </button>
        </div>
      </div>
    );
  }

  const scopes = (authDetails?.scope || '').split(/\s+/).filter(Boolean);

  // Consent form
  return (
    <div className="flex items-center justify-center min-h-screen bg-primary-bg">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold text-dark mb-2 text-center">Alfred</h1>
        <p className="text-sm text-muted text-center mb-6">Authorization Request</p>

        <div className="mb-6 p-4 bg-primary-bg rounded-lg border border-primary-light">
          <p className="text-dark font-medium mb-2">
            {authDetails?.client?.name || 'An application'} wants to access your Alfred data.
          </p>
          {authDetails?.redirect_uri && (
            <p className="text-xs text-muted break-all">
              Redirect: {authDetails.redirect_uri}
            </p>
          )}
          {scopes.length > 0 && (
            <div className="mt-3">
              <p className="text-sm text-muted mb-1">Requested permissions:</p>
              <ul className="list-disc list-inside text-sm text-dark">
                {scopes.map((scope) => (
                  <li key={scope}>{scope}</li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <p className="text-xs text-muted mb-4 text-center">
          Signed in as {user?.email}
        </p>

        <div className="flex gap-3">
          <button
            onClick={() => decide('deny')}
            disabled={submitting}
            className="flex-1 px-4 py-3 bg-gray-200 text-dark rounded-lg hover:bg-gray-300 transition-colors disabled:opacity-50"
          >
            Deny
          </button>
          <button
            onClick={() => decide('approve')}
            disabled={submitting}
            className="flex-1 px-4 py-3 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {submitting ? 'Processing...' : 'Approve'}
          </button>
        </div>
      </div>
    </div>
  );
}
