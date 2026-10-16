'use strict';

const assert = require('assert');
const { freelancersFromJobHtml, locationFromProfileHtml, preferredCountriesFromJobHtml } = require('../history-parse');

const jobHtml = `
<section>
  <h2>Client's recent history (2)</h2>
  <div>
    <a href="/jobs/~0211111111111111">Vector Raffaello De Luxe</a>
    <p>To freelancer: <a href="/freelancers/~01aabbccddeeff0011">Sophie J.</a></p>
  </div>
  <div>
    <a href="/jobs/~0222222222222222">64 vector</a>
    <p>To freelancer: <a href="https://www.upwork.com/freelancers/~01bbccddeeff001122">Pande S.</a></p>
  </div>
</section>
<script>
{"workHistory":[
  {"jobInfo":{"title":"Vector Raffaello De Luxe","ciphertext":"~0211111111111111"},
   "contractorInfo":{"contractorName":"Sophie J.","ciphertext":"~01aabbccddeeff0011"}},
  {"jobInfo":{"title":"64 vector","ciphertext":"~0222222222222222"},
   "contractorInfo":{"contractorName":"Pande S.","ciphertext":"~01bbccddeeff001122"}}
]}
</script>
`;

const people = freelancersFromJobHtml(jobHtml);
assert.deepStrictEqual(people.map((p) => p.name), ['Sophie J.', 'Pande S.']);
assert.strictEqual(people[0].url, 'https://www.upwork.com/freelancers/~01aabbccddeeff0011');
assert.ok(!people.some((p) => p.url.includes('~0211111111111111')));

const markupWins = freelancersFromJobHtml(`
  <script>{"workHistory":[{"contractorInfo":{"contractorName":"Other Person","ciphertext":"~01cccccccccccccccccc"}}]}</script>
  <h2>Client's recent history (1)</h2>
  <a href="/freelancers/~01aabbccddeeff0011">Sophie J.</a>
  <h2>About the client</h2>
`);
assert.deepStrictEqual(markupWins.map((p) => p.name), ['Sophie J.']);

const jsonOnly = freelancersFromJobHtml(`
  <script>{"buyerWorkHistory":[{"contractorInfo":{"contractorName":"Minh T.","ciphertext":"~01ddeeff0011223344"}}]}</script>
`);
assert.strictEqual(jsonOnly[0].name, 'Minh T.');
assert.strictEqual(jsonOnly[0].url, 'https://www.upwork.com/freelancers/~01ddeeff0011223344');

const vietnam = locationFromProfileHtml(`
  <div data-test="location"><span>Ho Chi Minh City, Vietnam</span></div>
  <script type="application/ld+json">{"@type":"Person","address":{"addressCountry":"United States"}}</script>
`);
assert.strictEqual(vietnam.label, 'Ho Chi Minh City, Vietnam');
assert.strictEqual(vietnam.vietnam, true);

const vietNamSpaced = locationFromProfileHtml(`<span data-qa="location">Hanoi, Viet Nam</span>`);
assert.strictEqual(vietNamSpaced.vietnam, true);

const unitedStates = locationFromProfileHtml(`
  <span>Austin, United States</span> – 10:42 am local time
  <script>{"workHistory":[{"location":{"city":"Da Nang","country":"Vietnam"}}]}</script>
`);
assert.strictEqual(unitedStates.country, 'United States');
assert.strictEqual(unitedStates.vietnam, false);

const proseOnly = locationFromProfileHtml(`
  <p>I have worked with clients across Vietnam and love Vietnamese food.</p>
`);
assert.strictEqual(proseOnly.vietnam, false);
assert.strictEqual(proseOnly.label, null);

const jsonProfile = locationFromProfileHtml(`
  <script>{"profile":{"location":{"city":"Can Tho","country":"Vietnam"}}}</script>
`);
assert.strictEqual(jsonProfile.label, 'Can Tho, Vietnam');
assert.strictEqual(jsonProfile.vietnam, true);

const code = locationFromProfileHtml(`<script>{"location":{"country":"VN","city":"Hue"}}</script>`);
assert.strictEqual(code.vietnam, true);

const several = preferredCountriesFromJobHtml(`
  <h2>Preferred qualifications</h2>
  <p>Talent Type: Independent</p>
  <p>Job Success Score: At least 90%</p>
  <p>Include Rising Talent: Yes</p>
  <p>Location: Egypt, Vietnam, Philippines</p>
  <h2>Activity on this job</h2>
  <p>Proposals: 5 to 10</p>
  <h2>Client's recent history (50)</h2>
  <p>Location: United States</p>
`);
assert.deepStrictEqual(several.countries, ['Egypt', 'Vietnam', 'Philippines']);
assert.strictEqual(several.vietnam, true);

const egyptOnly = preferredCountriesFromJobHtml(`
  <h2>Preferred qualifications</h2>
  <div>Location: Egypt</div>
`);
assert.deepStrictEqual(egyptOnly.countries, ['Egypt']);
assert.strictEqual(egyptOnly.vietnam, false);

const spaced = preferredCountriesFromJobHtml(`
  <h2>Preferred qualifications</h2>
  <div>Location:</div>
  <div>Viet Nam</div>
`);
assert.strictEqual(spaced.vietnam, true);

const fromJson = preferredCountriesFromJobHtml(`
  <script>{"qualifications":{"countries":[{"name":"India"},{"name":"Vietnam"}]}}</script>
`);
assert.deepStrictEqual(fromJson.countries, ['India', 'Vietnam']);
assert.strictEqual(fromJson.vietnam, true);

const visibleWins = preferredCountriesFromJobHtml(`
  <h2>Preferred qualifications</h2>
  <p>Location: Egypt</p>
  <script>{"qualifications":{"countries":["Vietnam"]}}</script>
`);
assert.deepStrictEqual(visibleWins.countries, ['Egypt']);
assert.strictEqual(visibleWins.vietnam, false);

console.log('history-parse: ok');
