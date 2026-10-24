// The user agent every request of the crawler sends. A profile sets its own with crawl.user_agent (an identifying name and a URL where
// site owners can read what the crawler does); setUserAgent() is called once by each command after loading the profile.
// UA is a live binding: modules that import it see the profile's value.
export const DEFAULT_UA = 'Mozilla/5.0 (compatible; jobcrawl; +https://github.com/egidinas/jobcrawl)';
export let UA = DEFAULT_UA;
export function setUserAgent(ua) { UA = ua || DEFAULT_UA; }
