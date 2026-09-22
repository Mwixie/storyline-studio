// Build 27 CloudKit configuration.
// The API token is a browser token, not a private server key. Restrict it to
// Storyline's deployed origin in CloudKit before enabling sync.
window.STORYLINE_CLOUDKIT_CONFIG = {
  enabled: false,
  containerIdentifier: '',
  apiToken: '',
  environment: 'development'
};
