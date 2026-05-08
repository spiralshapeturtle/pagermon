/* PagerMon auth components (Alpine.js)
 * Replaces auth.main.js (AngularJS 1.8)
 */

async function authApi(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 401) { window.location.href = '/auth/login'; return null; }
  return res.json().catch(() => ({ error: 'Invalid server response' }));
}

document.addEventListener('alpine:init', () => {

  Alpine.data('loginComponent', () => ({
    user: { username: '', password: '' },
    loading: false,
    message: null,

    async loginSubmit() {
      this.loading = true;
      this.message = null;
      try {
        const response = await authApi('POST', '/auth/login', this.user);
        if (response && response.status === 'ok') {
          window.location.href = response.redirect;
          return;
        }
        const errText = (response && response.error) ? response.error : 'Unknown error';
        this.message = { type: 'alert-danger', text: 'Login Error: ' + errText };
        setTimeout(() => { this.message = null; }, 3000);
      } catch (e) {
        this.message = { type: 'alert-danger', text: 'Login Error: Connection failed' };
        setTimeout(() => { this.message = null; }, 3000);
      }
      this.loading = false;
    }
  }));

  Alpine.data('registerComponent', () => ({
    user: { username: '', givenname: '', surname: '', email: '', password: '' },
    loading: false,
    userLoading: false,
    existingUsername: false,
    existingEmail: false,
    message: null,
    _usernameTimer: null,
    _emailTimer: null,

    debounceCheckUsername() {
      clearTimeout(this._usernameTimer);
      this._usernameTimer = setTimeout(() => this.checkUsername(), 400);
    },

    debounceCheckEmail() {
      clearTimeout(this._emailTimer);
      this._emailTimer = setTimeout(() => this.checkEmail(), 400);
    },

    async checkUsername() {
      if (!this.user.username) { this.existingUsername = false; return; }
      this.userLoading = true;
      try {
        const result = await authApi('GET', '/auth/userCheck/username/' + encodeURIComponent(this.user.username));
        this.existingUsername = !!(result && result.username);
      } catch (e) { this.existingUsername = false; }
      this.userLoading = false;
    },

    async checkEmail() {
      if (!this.user.email) { this.existingEmail = false; return; }
      this.userLoading = true;
      try {
        const result = await authApi('GET', '/auth/userCheck/email/' + encodeURIComponent(this.user.email));
        this.existingEmail = !!(result && result.email);
      } catch (e) { this.existingEmail = false; }
      this.userLoading = false;
    },

    async registerSubmit() {
      if (this.existingUsername) {
        this.message = { type: 'alert-danger', text: 'Error creating user: User with this username already exists.' };
        setTimeout(() => { this.message = null; }, 3000);
        return;
      }
      if (this.existingEmail) {
        this.message = { type: 'alert-danger', text: 'Error creating user: User with this email already exists.' };
        setTimeout(() => { this.message = null; }, 3000);
        return;
      }
      this.loading = true;
      try {
        const response = await authApi('POST', '/auth/register', this.user);
        if (response && response.status === 'ok') {
          window.location.href = response.redirect;
          return;
        }
        const errText = (response && response.error) ? response.error : 'Unknown error';
        this.message = { type: 'alert-danger', text: 'Error creating user: ' + errText };
        setTimeout(() => { this.message = null; }, 3000);
      } catch (e) {
        this.message = { type: 'alert-danger', text: 'Error creating user: Connection failed' };
        setTimeout(() => { this.message = null; }, 3000);
      }
      this.loading = false;
    }
  }));

  Alpine.data('resetComponent', () => ({
    password: '',
    confirmPassword: '',
    loading: false,
    message: null,

    get passwordsMatch() {
      return !this.confirmPassword || this.password === this.confirmPassword;
    },

    async resetSubmit() {
      if (!this.passwordsMatch) return;
      this.loading = true;
      this.message = null;
      try {
        const response = await authApi('POST', '/auth/reset', { password: this.password });
        if (response && response.status === 'ok') {
          window.location.href = response.redirect;
          return;
        }
        const errText = (response && response.error) ? response.error : 'Unknown error';
        this.message = { type: 'alert-danger', text: 'Failed to reset password: ' + errText };
        setTimeout(() => { this.message = null; }, 3000);
      } catch (e) {
        this.message = { type: 'alert-danger', text: 'Failed to reset password: Connection failed' };
        setTimeout(() => { this.message = null; }, 3000);
      }
      this.loading = false;
    }
  }));

  Alpine.data('profileComponent', () => ({
    user: {},
    loading: true,
    userLoading: false,
    existingEmail: false,
    _originalEmail: '',
    message: null,

    async init() {
      try {
        const result = await authApi('GET', '/auth/profile/me');
        if (result) {
          this.user = result;
          this._originalEmail = result.email || '';
          if (result.lastlogondate) {
            this.user.lastlogondate = new Date(result.lastlogondate).toLocaleString();
          }
        }
      } catch (e) {}
      this.loading = false;
    },

    async checkEmail() {
      if (!this.user.email || this.user.email === this._originalEmail) {
        this.existingEmail = false;
        return;
      }
      this.userLoading = true;
      try {
        const result = await authApi('GET', '/auth/userCheck/email/' + encodeURIComponent(this.user.email));
        this.existingEmail = !!(result && result.email);
      } catch (e) { this.existingEmail = false; }
      this.userLoading = false;
    },

    async userSubmit() {
      if (this.existingEmail) return;
      this.loading = true;
      try {
        const response = await authApi('POST', '/auth/profile/me', this.user);
        if (response && response.status === 'ok') {
          this.message = { type: 'alert-success', text: 'User saved!' };
          setTimeout(() => { this.message = null; }, 3000);
        } else {
          const errText = (response && response.error) ? response.error : 'Unknown error';
          this.message = { type: 'alert-danger', text: 'Error saving user: ' + errText };
          setTimeout(() => { this.message = null; }, 3000);
        }
      } catch (e) {
        this.message = { type: 'alert-danger', text: 'Error saving user: Connection failed' };
        setTimeout(() => { this.message = null; }, 3000);
      }
      this.loading = false;
    }
  }));

});
