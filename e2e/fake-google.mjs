// Stand-in for Google's token endpoints, so tests can sign in without a real Google account.
// Build and run the server with VITE_GOOGLE_CLIENT_ID=test-client and GOOGLE_TOKENINFO_URL / GOOGLE_USERINFO_URL
// pointing here (from Docker: http://host.docker.internal:<port>/tokeninfo and /userinfo).
// A test access token is "fake.<email>"; emails starting with "unverified" are unverified,
// and "fake-otherapp.<email>" is a token issued to another app.
import http from 'node:http'

export const FAKE_CLIENT_ID = 'test-client'

export function fakeToken(email) {
  return `fake.${email}`
}

function parse(token) {
  const match = /^fake(-otherapp)?\.(.+@.+)$/.exec(token ?? '')
  if (!match) {
    return null
  }
  return { otherApp: Boolean(match[1]), email: match[2] }
}

export function startFakeGoogle(port = 18199) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/tokeninfo') {
      const token = parse(url.searchParams.get('access_token'))
      if (!token) {
        return send(400, { error_description: 'Invalid Value' })
      }
      const aud = token.otherApp ? 'some-other-app' : FAKE_CLIENT_ID
      return send(200, { aud, azp: aud, scope: 'openid email profile', expires_in: '3599' })
    }
    if (url.pathname === '/userinfo') {
      const token = parse((req.headers.authorization ?? '').replace(/^Bearer /, ''))
      if (!token) {
        return send(401, { error: 'invalid_request' })
      }
      const local = token.email.split('@')[0]
      return send(200, {
        sub: `sub-${token.email}`,
        email: token.email,
        email_verified: !local.startsWith('unverified'),
        name: local.charAt(0).toUpperCase() + local.slice(1),
      })
    }
    return send(404, {})
  })
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)))
}

/** Browser-side stub of Google's sign-in script: the popup "picks" the given account immediately. */
export function gisStub(email) {
  return `window.google = { accounts: { oauth2: { initTokenClient: (config) => ({
    requestAccessToken: () => setTimeout(() => config.callback({ access_token: ${JSON.stringify(fakeToken(email))} }), 50),
  }), revoke: () => {} } } };`
}
