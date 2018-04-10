const os = require('os');
const fs = require('fs');
const utils = require('util');
const path = require('path');
const fsExtra = require('fs-extra');
const bsInit = require('blinksocks/bin/init');
const { Config } = require('blinksocks');

const runServer = require('./core/server');
const { ServiceManager, logger } = require('./utils');

const {
  HASH_SALT,
  RUN_TYPE_CLIENT,
  RUN_TYPE_SERVER,
  RUNTIME_HELPERS_PAC_PATH,
  RUNTIME_HELPERS_SYSPROXY_PATH,
} = require('./constants');

const { db, hash } = require('./utils');

const chmod = utils.promisify(fs.chmod);

function getSysArch() {
  const arch = os.arch();
  switch (arch) {
    case'x32':
      return '386';
    case 'x64':
      return 'amd64';
    default:
      throw Error('unsupported architecture: ' + arch);
  }
}

async function copy(source, target) {
  if (process.pkg) {
    // use stream pipe to reduce memory usage
    // when load a large file into memory.
    fs.createReadStream(source).pipe(fs.createWriteStream(target));
  } else {
    await fsExtra.copy(source, target);
  }
}

async function extractHelpers() {
  // copy system-related helper tools to runtime/helpers
  const platform = os.platform();
  const arch = getSysArch();

  const pac_cmd_binaries_path = path.resolve(__dirname, '../vendor/pac-cmd/binaries');
  const sysproxy_binaries_path = path.resolve(__dirname, '../vendor/sysproxy-cmd/binaries');

  switch (platform) {
    case 'darwin':
      await copy(path.join(pac_cmd_binaries_path, 'darwin/pac'), RUNTIME_HELPERS_PAC_PATH);
      await copy(path.join(sysproxy_binaries_path, 'darwin/sysproxy'), RUNTIME_HELPERS_SYSPROXY_PATH);
      break;
    case 'linux':
      await copy(path.join(pac_cmd_binaries_path, `linux_${arch}/pac`), RUNTIME_HELPERS_PAC_PATH);
      await copy(path.join(sysproxy_binaries_path, `linux_${arch}/sysproxy`), RUNTIME_HELPERS_SYSPROXY_PATH);
      break;
    case 'win32':
      await copy(path.join(pac_cmd_binaries_path, `windows/pac_${arch}`), RUNTIME_HELPERS_PAC_PATH);
      await copy(path.join(sysproxy_binaries_path, `windows/sysproxy_${arch}`), RUNTIME_HELPERS_SYSPROXY_PATH);
      break;
    default:
      throw Error('unsupported platform: ' + platform);
  }

  // grant execute permission
  await chmod(RUNTIME_HELPERS_PAC_PATH, 0o774);
  await chmod(RUNTIME_HELPERS_SYSPROXY_PATH, 0o774);
}

module.exports = async function main(args) {
  const { runType } = args;
  try {
    // create runtime directory
    await fsExtra.mkdirp('runtime/logs');

    let configs = null;

    // keep at least one config in database
    const { clientJson, serverJson } = bsInit({ isMinimal: false, isDryRun: true });
    if (runType === RUN_TYPE_CLIENT) {
      configs = db.get('client_configs');
      if (configs.size().value() < 1) {
        clientJson.remarks = 'Default';
        configs.insert(clientJson).write();
      }
      // await extractHelpers();
    }
    if (runType === RUN_TYPE_SERVER) {
      configs = db.get('server_configs');
      if (configs.size().value() < 1) {
        serverJson.remarks = 'Default';
        configs.insert(serverJson).write();
      }
    }

    // add a default user if no users set
    const users = db.get('users');
    if (users.value().length < 1) {
      users.insert({
        'name': 'root',
        'password': hash('SHA-256', 'root' + HASH_SALT),
        'disallowed_methods': [],
      }).write();
    }

    // start server
    await runServer(args);

    // start services in "auto_start_services"
    const ids = db.get('auto_start_services').value();
    for (const id of ids) {
      const config = configs.find({ id }).value();
      if (config) {
        try {
          Config.test(config);
          await ServiceManager.start(id, config);
          logger.info(`auto started service: ${config.remarks}`);
        } catch (err) {
          logger.error(`cannot auto start service "${config.remarks}": %s`, err.stack);
        }
      }
    }

  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};
