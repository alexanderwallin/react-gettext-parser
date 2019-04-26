import fs from 'fs';
import { promisify } from 'util';

const asyncWrite = promisify(fs.writeFile);

export const outputPot = (filePath, contents, cb = () => {}) => {
  let promise = null;

  if (filePath) {
    promise = asyncWrite(filePath, contents);
  }
  else {
    console.log(contents);
    promise = Promise.resolve();
  }

  return promise
    .then(() => console.log(`Did write .pot contents to ${filePath}`.green))
    .catch((...err) => console.error(err))
    .then(cb);
};
