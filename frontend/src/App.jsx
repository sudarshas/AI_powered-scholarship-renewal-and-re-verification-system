import { useEffect, useState } from 'react';
import { AdminDashboard, StudentDashboard } from './Workflow.jsx';
import { apiErrorMessage } from './apiErrors.js';

// An empty base URL keeps production frontend/API traffic on the same origin.
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export default function App() {
  const [apiStatus, setApiStatus] = useState('Checking connection...');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [user, setUser] = useState(null);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/health`)
      .then((response) => {
        if (!response.ok) throw new Error('Backend returned an error');
        return response.json();
      })
      .then((data) => setApiStatus(`Connected: ${data.status}`))
      .catch(() => setApiStatus('Unable to reach the backend'));
  }, []);

  useEffect(() => {
    fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/auth/me`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then((account) => {
        if (!account) return;
        setUser(account);
      })
      .catch(() => {});
  }, []);

  async function handleAuth(event) {
    event.preventDefault();
    setAuthLoading(true);
    setAuthError('');
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(apiErrorMessage(result, 'Unable to sign in. Please try again.'));
      }
      setUser(result);
      setPassword('');
    } catch (error) {
      setAuthError(error instanceof TypeError
        ? 'Unable to reach the sign-in service. Check that the backend and AI service are running, then try again.'
        : error.message || 'Unable to sign in. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handlePasswordChange(event) {
    event.preventDefault();
    setAuthLoading(true);
    setAuthError('');
    if (newPassword !== confirmPassword) {
      setAuthError('The new passwords do not match.');
      setAuthLoading(false);
      return;
    }
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/auth/change-password`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(apiErrorMessage(result, 'Unable to change password. Please try again.'));
      }
      setUser(result);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      setAuthError(error instanceof TypeError ? 'Unable to reach the password service. Check that the services are running.' : error.message || 'Unable to change password.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    setAuthError('');
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Sign-out failed. Please try again.');
      setUser(null);
      setPassword('');
      setPasswordVisible(false);
      setCurrentPassword('');
    } catch (error) {
      setAuthError(error.message || 'Unable to reach the sign-in service.');
    }
  }

  return (
    <main className="page">
      {!user && (
        <header className="portal-header">
          <div className="portal-brand"><span className="brand-mark" aria-hidden="true">SR</span><span>Scholarship Renewal Portal</span></div>
          <h1>Welcome back</h1>
          <p className="intro">Sign in with the account provided by your college. We’ll take you to the right workspace.</p>
        </header>
      )}
      <section className={user ? 'account-bar' : 'auth card auth-entry'} aria-labelledby={user ? undefined : 'auth-heading'} aria-label={user ? 'Signed-in account' : undefined}>
        {!user && <h2 id="auth-heading">Sign in</h2>}
        {user ? (
          <div className="account-details">
            <span>Signed in as <strong>{user.email}</strong></span>
            <button type="button" onClick={handleSignOut}>Sign out</button>
          </div>
        ) : (
          <>
            <p className="auth-hint">Use your college email and the password provided to you. Your account role opens the correct workspace.</p>
            <form onSubmit={handleAuth}>
              <label htmlFor="account-email">Email</label>
              <input id="account-email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required />
              <label htmlFor="account-password">Password</label>
              <div className="password-field">
                <input id="account-password" type={passwordVisible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
                <button className="password-toggle" type="button" aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>{passwordVisible ? 'Hide' : 'Show'}</button>
              </div>
              <button type="submit" disabled={authLoading}>
                {authLoading ? <><span className="button-spinner" aria-hidden="true" />Signing in...</> : 'Sign in'}
              </button>
            </form>
            <p className="admin-note">Student accounts are created by the college. Contact your college administrator if you need access. Admin accounts are also issued by the organization.</p>
          </>
        )}
        {authError && <p className="form-error" role="alert">{authError}</p>}
        {!user && <p className={`connection-note ${apiStatus.startsWith('Connected') ? 'is-connected' : ''}`} role="status"><span aria-hidden="true" />{apiStatus}</p>}
      </section>
      {user?.password_change_required ? (
        <section className="card workflow-card first-password-card">
          <p className="eyebrow">First sign-in required</p>
          <h2>Choose a new password</h2>
          <p>Your roll number was your temporary password. Change it now to continue to your account.</p>
          <form className="first-password-form" onSubmit={handlePasswordChange}>
            <label>Current password (roll number)<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required /></label>
            <label>New password (at least 12 characters)<input type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
            <label>Confirm new password<input type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
            <button type="submit" disabled={authLoading}>{authLoading ? 'Saving password...' : 'Change password and continue'}</button>
          </form>
          {authError && <p className="form-error" role="alert">{authError}</p>}
        </section>
      ) : user?.role === 'student' ? <StudentDashboard key={user.id} user={user} /> : null}
      {!user?.password_change_required && user?.role === 'admin' && <AdminDashboard key={user.id} />}
    </main>
  );
}
