import { Op } from 'sequelize';
import { Command } from 'commander';

import Database from '../../src/config/initializers/database';
import initDeletedFileModel from '../../src/app/models/deletedFile';
import { createTimer, deleteFiles, DeleteFilesResponse, getFilesToDelete, signToken } from './utils';

type CommandOptions = {
  secret: string
  dbHostname: string
  dbName: string
  dbUsername: string
  dbPassword: string
  concurrency?: number
  endpoint: string
}

const commands: { flags: string, description: string, required: boolean }[] = [
  {
    flags: '-s, --secret <token_secret>',
    description: 'The secret used to sign the token to request files deletion',
    required: true
  },
  {
    flags: '--db-hostname <database_hostname>',
    description: 'The hostname of the database where deleted files are stored',
    required: true
  },
  {
    flags: '--db-name <database_name>',
    description: 'The name of the database where deleted files are stored',
    required: true
  },
  {
    flags: '--db-username <database_username>',
    description: 'The username authorized to read and delete from the deleted files table',
    required: true
  },
  {
    flags: '--db-password <database_password>',
    description: 'The database username password',
    required: true
  },
  {
    flags: '-c, --concurrency <concurrency>',
    description: 'The concurrency level of the requests that will be made',
    required: false
  },
  {
    flags: '-e, --endpoint <endpoint>',
    description: 'The API endpoint where the delete files requests are sent',
    required: true
  }
];

const command = new Command('delete-files')
  .version('0.0.1');

commands.forEach(c => {
  if (c.required) {
    command.requiredOption(c.flags, c.description);
  } else {
    command.option(c.flags, c.description);
  }
});

command.parse();

const opts: CommandOptions = command.opts();
const db = Database.getInstance({
  sequelizeConfig: {
    host: opts.dbHostname,
    database: opts.dbName,
    username: opts.dbUsername,
    password: opts.dbPassword,
    dialect: 'mariadb',
  }
});

const timer = createTimer();
timer.start();

let totalFilesRemoved = 0;

const logIntervalId = setInterval(() => {
  console.log('RATE: %s/s', totalFilesRemoved / (timer.end()/1000));
}, 1000);

function finishProgram() {
  clearInterval(logIntervalId);

  console.log(
    'TOTAL FILES REMOVED %s | DURATION %ss', 
    totalFilesRemoved, 
    (timer.end()/1000).toFixed(2)
  );
  db.close().then(() => {
    console.log('DISCONNECTED FROM DB');
  }).catch((err) => {
    console.log('Error closing connection %s. %s', err.message. err.stack || 'NO STACK.');
  });
}

process.on('SIGINT', () => finishProgram());

async function start(limit = 20, concurrency = 5) {
  const deletedFile = initDeletedFileModel(db);

  let fileIds = [];

  do {
    const files = await getFilesToDelete(deletedFile, limit);

    fileIds = files.map(f => f.fileId);
 
    const promises = [];
    const chunksOf = Math.ceil(limit/concurrency);

    for (let i = 0; i < fileIds.length; i += chunksOf) {
      promises.push(
        deleteFiles(
          opts.endpoint,
          fileIds.slice(i, i + chunksOf), 
          signToken('5m', opts.secret)
        )
      );
    }

    const results = await Promise.allSettled(promises);

    const filesIdsToRemove = results
      .filter((r) => r.status === 'fulfilled')
      .flatMap((r) => (r as PromiseFulfilledResult<DeleteFilesResponse>).value.message.confirmed);

    const deletedFilesToDelete = files.filter(f => {
      return filesIdsToRemove.some(fId => fId === f.fileId);
    });

    if (deletedFilesToDelete.length > 0) {
      await deletedFile.destroy({ where: { id: { [Op.in]: deletedFilesToDelete.map(f => f.id) }}});
    }

    totalFilesRemoved += deletedFilesToDelete.length;
  } while (fileIds.length === limit);
}

start(10, opts.concurrency)
  .catch((err) => {
    console.log('err', err);
  }).finally(() => {
    finishProgram();
  });
