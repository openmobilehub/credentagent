// Links a card must refuse (spec 015 FR-11). The click test and the markup test share this one list,
// so a check that weakens on either path fails the same addresses.
export const UNSAFE_LINKS = [
  "javascript:alert(1)", // React 19 rewrites this href, so only the button and sentence checks count here
  "data:text/html,hi", // no < or >: React escapes those in an href, so the raw link would never match
  "/credentagent/grants/g1",
  "http://example.test/approve",
  "http://localhost.evil.test/approve", // the host is localhost.evil.test
  "http://localhost@evil.test/approve", // the host is evil.test; localhost is only a user name
  "not a url",
  "ftp://localhost/approve", // a local host, but not a web scheme: only http: may use one
  "http://shop.localhost/approve", // a *.localhost subdomain is not localhost
  "http://192.168.1.10/approve", // a LAN address on plain http:
  "http://shop.local/approve", // a .local name on plain http:
  "http://127.0.0.1.evil.test/approve", // a domain name that only starts like 127.0.0.1
  "http://localhost:80@evil.test/approve", // the host is evil.test; localhost:80 is a user name and password
];
