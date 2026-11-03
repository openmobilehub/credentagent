// Links a card must refuse (spec 015 FR-11). The click test and the markup test share this one list,
// so a check that weakens on either path fails the same addresses.
export const UNSAFE_LINKS = [
  "javascript:alert(1)",
  "data:text/html,hi", // no < or >: React escapes those in an href, so the raw link would never match
  "/credentagent/grants/g1",
  "http://example.test/approve",
  "http://localhost.evil.test/approve", // the host is localhost.evil.test
  "http://localhost@evil.test/approve", // the host is evil.test; localhost is only a user name
  "not a url",
];
