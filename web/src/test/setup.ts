import "@testing-library/jest-dom";

// jsdom implements no layout, so scrollIntoView exists in every real browser
// but not here. Stubbing it in the setup rather than guarding for it inside
// components keeps the components honest — its absence is a fact about the test
// environment, not something the app should be checking for at runtime.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
