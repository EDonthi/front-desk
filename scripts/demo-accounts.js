// creates the two readme test logins via the same createAccount() as the sign-up page.
// it's a manual step (npm run setup) so nobody gets an account without choosing to.
const { allowedUsers } = require('../server');
const { createAccount, AccountError } = require('../lib/accounts');

// demo passwords for this exercise only
const DEMO = [
  { email: 'dana.whitfield@brightline.example', password: 'frontdesk-admin' },
  { email: 'sam.ferreira@brightline.example', password: 'frontdesk-viewer' },
];

for (const { email, password } of DEMO) {
  try {
    const user = createAccount(allowedUsers, email, password);
    console.log(`Created ${user.role} account ${email} / ${password}`);
  } catch (err) {
    // already exists = fine, so the script is safe to re-run
    if (err instanceof AccountError && err.status === 409) console.log(`${email} already has an account, leaving it alone.`);
    else throw err;
  }
}
