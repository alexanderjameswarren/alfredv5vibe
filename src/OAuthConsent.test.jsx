import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import OAuthConsent from './OAuthConsent';
import { supabase } from './supabaseClient';

jest.mock('./supabaseClient', () => ({
  supabase: {
    auth: {
      getUser: jest.fn(),
      signInWithOAuth: jest.fn(),
      oauth: {
        getAuthorizationDetails: jest.fn(),
        approveAuthorization: jest.fn(),
        denyAuthorization: jest.fn(),
      },
    },
  },
}));

const oauth = supabase.auth.oauth;
const details = {
  authorization_id: 'auth-1',
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
  client: { name: 'Workshop (Surface)' },
  user: { id: 'u1', email: 'a@b.c' },
  scope: 'openid email',
};
const originalLocation = window.location;
let replace;

beforeEach(() => {
  jest.clearAllMocks();
  replace = jest.fn();
  delete window.location;
  window.location = { search: '?authorization_id=auth-1', href: '', replace };
  supabase.auth.getUser.mockResolvedValue({ data: { user: { email: 'a@b.c' } } });
});

afterAll(() => {
  window.location = originalLocation;
});

test('already consented redirects without approving', async () => {
  oauth.getAuthorizationDetails.mockResolvedValue({ data: { redirect_url: 'https://cb?code=1' }, error: null });
  render(<OAuthConsent />);
  await waitFor(() => expect(replace).toHaveBeenCalledWith('https://cb?code=1'));
  expect(screen.getByText('Redirecting…')).toBeInTheDocument();
  expect(screen.queryByText('Approve')).not.toBeInTheDocument();
  expect(oauth.approveAuthorization).not.toHaveBeenCalled();
});

test('details show client name and scopes, approve redirects', async () => {
  oauth.getAuthorizationDetails.mockResolvedValue({ data: details, error: null });
  oauth.approveAuthorization.mockResolvedValue({ data: { redirect_url: 'https://cb?code=2' }, error: null });
  render(<OAuthConsent />);
  expect(await screen.findByText(/Workshop \(Surface\) wants to access/)).toBeInTheDocument();
  expect(screen.getByText('openid')).toBeInTheDocument();
  expect(screen.getByText('email')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Approve'));
  await waitFor(() => expect(replace).toHaveBeenCalledWith('https://cb?code=2'));
  expect(oauth.approveAuthorization).toHaveBeenCalledWith('auth-1', { skipBrowserRedirect: true });
});

test('deny uses skipBrowserRedirect and redirects', async () => {
  oauth.getAuthorizationDetails.mockResolvedValue({ data: details, error: null });
  oauth.denyAuthorization.mockResolvedValue({ data: { redirect_url: 'https://cb?error=access_denied' }, error: null });
  render(<OAuthConsent />);
  fireEvent.click(await screen.findByText('Deny'));
  await waitFor(() => expect(replace).toHaveBeenCalledWith('https://cb?error=access_denied'));
  expect(oauth.denyAuthorization).toHaveBeenCalledWith('auth-1', { skipBrowserRedirect: true });
});

describe('approve returns no longer pending', () => {
  const pending = { data: null, error: { message: 'authorization request is no longer pending' } };

  test('follows redirect from re-fetch', async () => {
    oauth.getAuthorizationDetails
      .mockResolvedValueOnce({ data: details, error: null })
      .mockResolvedValueOnce({ data: { redirect_url: 'https://cb?code=3' }, error: null });
    oauth.approveAuthorization.mockResolvedValue(pending);
    render(<OAuthConsent />);
    fireEvent.click(await screen.findByText('Approve'));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('https://cb?code=3'));
    expect(oauth.getAuthorizationDetails).toHaveBeenCalledTimes(2);
  });

  test('shows expired card when re-fetch has no redirect', async () => {
    oauth.getAuthorizationDetails
      .mockResolvedValueOnce({ data: details, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'not found' } });
    oauth.approveAuthorization.mockResolvedValue(pending);
    render(<OAuthConsent />);
    fireEvent.click(await screen.findByText('Approve'));
    expect(await screen.findByText(/expired or was already used/)).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
