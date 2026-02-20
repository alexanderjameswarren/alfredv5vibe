import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

export default function OAuthConsent() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [authDetails, setAuthDetails] = useState(null);
  const [user, setUser] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const params = new URLSearchParams(window.location.search);
  const authorizationId = params.get('authorization_id');

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

  async function handleApprove() {
    setSubmitting(true);
    try {
      const { data, error: approveError } = await supabase.auth.oauth.approveAuthorization(authorizationId);
      if (approveError) {
        setError(approveError.message || 'Failed to approve authorization.');
        setSubmitting(false);
        return;
      }
      if (data?.redirect_to) {
        window.location.href = data.redirect_to;
      }
    } catch (e) {
      setError('Failed to approve: ' + String(e));
      setSubmitting(false);
    }
  }

  async function handleDeny() {
    setSubmitting(true);
    try {
      const { data, error: denyError } = await supabase.auth.oauth.denyAuthorization(authorizationId);
      if (denyError) {
        setError(denyError.message || 'Failed to deny authorization.');
        setSubmitting(false);
        return;
      }
      if (data?.redirect_to) {
        window.location.href = data.redirect_to;
      }
    } catch (e) {
      setError('Failed to deny: ' + String(e));
      setSubmitting(false);
    }
  }

  // Loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-primary-bg">
        <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-md text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-dark font-medium">Loading authorization details...</p>
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

  // Consent form
  return (
    <div className="flex items-center justify-center min-h-screen bg-primary-bg">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-md">
        <h1 className="text-2xl font-bold text-dark mb-2 text-center">Alfred</h1>
        <p className="text-sm text-muted text-center mb-6">Authorization Request</p>

        <div className="mb-6 p-4 bg-primary-bg rounded-lg border border-primary-light">
          <p className="text-dark font-medium mb-2">
            {authDetails?.application?.name || 'An application'} wants to access your Alfred data.
          </p>
          {authDetails?.application?.redirect_uri && (
            <p className="text-xs text-muted break-all">
              Redirect: {authDetails.application.redirect_uri}
            </p>
          )}
          {authDetails?.scopes && authDetails.scopes.length > 0 && (
            <div className="mt-3">
              <p className="text-sm text-muted mb-1">Requested permissions:</p>
              <ul className="list-disc list-inside text-sm text-dark">
                {authDetails.scopes.map((scope, i) => (
                  <li key={i}>{scope}</li>
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
            onClick={handleDeny}
            disabled={submitting}
            className="flex-1 px-4 py-3 bg-gray-200 text-dark rounded-lg hover:bg-gray-300 transition-colors disabled:opacity-50"
          >
            Deny
          </button>
          <button
            onClick={handleApprove}
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
