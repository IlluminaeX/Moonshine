// Update signing for scripts/release.ps1 (plain Node, no packages).
//   node sign-update.js keygen <keyFile>                  make a key pair; prints the public key
//   node sign-update.js public <keyFile>                  print the public key of an existing key
//   node sign-update.js sign <keyFile> <installer> <version>   write <installer>.sig
// The private key file must stay outside the repository. Lose it and the apps already out there
// can't take another in-app update (a manual reinstall with a new key would be needed).
const fs = require('fs');
const crypto = require('crypto');

const [cmd, keyFile, installer, version] = process.argv.slice(2);
const publicOf = (key) => crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');

if (cmd === 'keygen') {
  if (fs.existsSync(keyFile)) throw new Error(`${keyFile} already exists; not overwriting it`);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log(publicOf(privateKey));
} else if (cmd === 'public') {
  console.log(publicOf(crypto.createPrivateKey(fs.readFileSync(keyFile))));
} else if (cmd === 'sign') {
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version || '')) throw new Error(`bad version "${version}"`);
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');
  const signature = crypto.sign(null, Buffer.from(`moonshine-update-v1:${version}:${sha256}`), key).toString('base64');
  fs.writeFileSync(`${installer}.sig`, `${JSON.stringify({ version, sha256, signature }, null, 2)}\n`);
  console.log(`Signed ${installer} as ${version} (sha256 ${sha256})`);
} else {
  console.error('usage: node sign-update.js keygen|public|sign <keyFile> [installer version]');
  process.exit(2);
}
