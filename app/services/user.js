const axios = require('axios');
const sequelize = require('sequelize');
const async = require('async');
const uuid = require('uuid');
const { Sequelize } = require('sequelize');
const crypto = require('crypto-js');
const Analytics = require('./analytics');

const { Op } = sequelize;

const SYNC_KEEPALIVE_INTERVAL_MS = 30 * 1000; // 30 seconds

module.exports = (Model, App) => {
  const Logger = App.logger;
  const analytics = Analytics(Model, App);

  const FindOrCreate = (user) => {
    // Create password hashed pass only when a pass is given
    const userPass = user.password ? App.services.Crypt.decryptText(user.password) : null;
    const userSalt = user.salt ? App.services.Crypt.decryptText(user.salt) : null;

    // Throw error when user email. pass, salt or mnemonic is missing
    if (!user.email || !userPass || !userSalt || !user.mnemonic) {
      throw new Error('Wrong user registration data');
    }

    return Model.users.sequelize.transaction(async (t) => Model.users
      .findOrCreate({
        where: { email: user.email },
        defaults: {
          name: user.name,
          lastname: user.lastname,
          password: userPass,
          mnemonic: user.mnemonic,
          hKey: userSalt,
          referral: user.referral,
          uuid: null,
          referred: user.referred,
          credit: user.credit,
          welcomePack: true
        },
        transaction: t
      })
      .spread(async (userResult, created) => {
        if (created) {
          if (user.publicKey && user.privateKey && user.revocationKey) {
            Model.keyserver.findOrCreate({
              where: { user_id: userResult.id },
              defaults: {
                user_id: user.id,
                private_key: user.privateKey,
                public_key: user.publicKey,
                revocation_key: user.revocationKey,
                encrypt_version: null
              },
              transaction: t
            });
          }

          // Create bridge pass using email (because id is unconsistent)
          const bcryptId = await App.services.Storj.IdToBcrypt(userResult.email);

          const bridgeUser = await App.services.Storj.RegisterBridgeUser(userResult.email,
            bcryptId);

          if (bridgeUser && bridgeUser.response && bridgeUser.response.status === 500) {
            throw Error(bridgeUser.response.data.error);
          }

          Logger.info('User Service | created brigde user: %s', userResult.email);
          if (!bridgeUser.data) {
            throw new Error('Error creating bridge user');
          }

          Logger.info('User Service | created brigde user: %s', userResult.email);

          const freeTier = bridgeUser.data ? bridgeUser.data.isFreeTier : 1;
          // Store bcryptid on user register
          await userResult.update({
            userId: bcryptId,
            isFreeTier: freeTier,
            uuid: bridgeUser.data.uuid
          }, { transaction: t });

          // Set created flag for Frontend management
          Object.assign(userResult, { isCreated: created });
        }

        // TODO: proveriti userId kao pass
        return userResult;
      }).catch((err) => {
        if (err.response) {
          // This happens when email is registered in bridge
          Logger.error(err.response.data);
        } else {
          Logger.error(err.stack);
        }

        throw new Error(err);
      })); // end transaction
  };

  const InitializeUser = (user) => Model.users.sequelize.transaction((t) => Model.users
    .findOne({ where: { email: { [Op.eq]: user.email } } }).then(async (userData) => {
      if (userData.root_folder_id) {
        userData.mnemonic = user.mnemonic;

        return userData;
      }

      const { Storj, Crypt } = App.services;
      const rootBucket = await Storj.CreateBucket(userData.email, userData.userId, user.mnemonic);
      Logger.info('User init | root bucket created %s', rootBucket.name);

      const rootFolderName = await Crypt.encryptName(`${rootBucket.name}`);
      const rootFolder = await userData.createFolder({
        name: rootFolderName,
        bucket: rootBucket.id
      });

      Logger.info('User init | root folder created, id: %s', rootFolder.id);

      // Update user register with root folder Id
      await userData.update({ root_folder_id: rootFolder.id },
        { transaction: t });

      // Set decrypted mnemonic to returning object
      const updatedUser = userData;
      updatedUser.mnemonic = user.mnemonic;

      return updatedUser;
    }).catch((error) => {
      Logger.error(error.stack);
      throw new Error(error);
    }));

  // Get an email and option (true/false) and set storeMnemonic option for user with this email
  const UpdateStorageOption = (email, option) => Model.users
    .findOne({ where: { email: { [Op.eq]: email } } }).then((userData) => {
      if (userData) {
        return userData.update({ storeMnemonic: option });
      }

      throw new Error('UpdateStorageOption: User not found');
    }).catch((error) => {
      Logger.error(error.stack);
      throw new Error(error);
    });

  const GetUserById = (id) => Model.users.findOne({
    where: {
      id: { [Op.eq]: id }
    }
  }).then((response) => response.dataValues);

  const FindUserByEmail = (email) => new Promise((resolve, reject) => {
    Model.users
      .findOne({ where: { email: { [Op.eq]: email } } }).then((userData) => {
        if (userData) {
          const user = userData.dataValues;
          if (user.mnemonic) user.mnemonic = user.mnemonic.toString();

          resolve(user);
        } else {
          reject(Error('User not found on X Cloud database'));
        }
      }).catch((err) => reject(err));
  });

  const FindUserByUuid = (userUuid) => Model.users.findOne({
    where: {
      uuid: { [Op.eq]: userUuid }
    }
  });

  const FindUsersByReferred = (referredUuid) => Model.users
    .findAll({ where: { referred: { [Op.eq]: referredUuid } } });

  const FindUserObjByEmail = (email) => Model.users.findOne({
    where: {
      email: { [Op.eq]: email }
    }
  });

  const GetUserCredit = (userUuid) => Model.users.findOne({
    where: {
      uuid: { [Op.eq]: userUuid }
    }
  }).then((response) => response.dataValues);

  const GetUsersRootFolder = () => Model.users
    .findAll({
      include: [Model.folder]
    }).then((user) => user.dataValues);

  const UpdateMnemonic = async (userEmail, mnemonic) => {
    const found = FindUserByEmail(userEmail);
    if (found) {
      try {
        const user = await Model.users.update({ mnemonic },
          { where: { email: { [Op.eq]: userEmail } }, validate: true });

        return user;
      } catch (errorResponse) {
        throw new Error(errorResponse);
      }
    } else {
      return null;
    }
  };

  const UpdateCredit = (userUuid) => {
    // Logger.info("€5 added to ", referral);
    Logger.info('€5 added to user with UUID %s', userUuid);

    return Model.users.update({ credit: Sequelize.literal('credit + 5') },
      { where: { uuid: { [Op.eq]: userUuid } } });
  };

  const DecrementCredit = (userUuid) => {
    Logger.info('€5 decremented to user with UUID %s', userUuid);

    return Model.users.update({ credit: Sequelize.literal('credit - 5') },
      { where: { uuid: { [Op.eq]: userUuid } } });
  };

  const DeactivateUser = (email) => new Promise((resolve, reject) => Model.users
    .findOne({ where: { email: { [Op.eq]: email } } }).then((user) => {
      const password = crypto.SHA256(user.userId).toString();
      const auth = Buffer.from(`${user.email}:${password}`).toString('base64');

      axios
        .delete(`${App.config.get('STORJ_BRIDGE')}/users/${email}`, {
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/json'
          }
        }).then((data) => {
          resolve(data);
        }).catch((err) => {
          Logger.warn(err.response.data);
          reject(err);
        });
    }).catch(reject));

  const ConfirmDeactivateUser = (token) => new Promise((resolve, reject) => {
    async.waterfall([
      (next) => {
        axios
          .get(`${App.config.get('STORJ_BRIDGE')}/deactivationStripe/${token}`,
            { headers: { 'Content-Type': 'application/json' } }).then((res) => {
            Logger.info('User deleted from bridge');
            next(null, res);
          }).catch((err) => {
            Logger.error('Error user deleted from bridge');
            next(err);
          });
      },
      (data, next) => {
        const userEmail = data.data.email;
        Model.users
          .findOne({ where: { email: { [Op.eq]: userEmail } } }).then((user) => {
            const referralUuid = user.referral;
            if (uuid.validate(referralUuid)) {
              DecrementCredit(referralUuid);
            }

            user.destroy().then(() => {
              analytics.track({
                userId: user.uuid,
                event: 'user-deactivation-confirm',
                properties: {
                  email: userEmail
                }
              });
              Logger.info('User deleted on sql: %s', userEmail);
              next(null, data);
            }).catch((err) => {
              Logger.error('Error deleting user on sql');
              next(err);
            });
          }).catch(next);
      }
    ], (err, result) => {
      if (err) {
        Logger.error('Error waterfall', err);
        reject(err);
      } else {
        resolve(result);
      }
    });
  });

  const Store2FA = (user, key) => Model.users
    .update({ secret_2FA: key }, { where: { email: { [Op.eq]: user } } });

  const Delete2FA = (user) => Model.users.update({ secret_2FA: null },
    { where: { email: { [Op.eq]: user } } });

  const updatePrivateKey = (user, privateKey) => new Promise((resolve, reject) => {
    FindUserByEmail(user).then((userData) => {
      const idUser = userData.id;
      Model.keyserver
        .update({
          private_key: privateKey
        }, { where: { user_id: { [Op.eq]: idUser } } }).then((res) => {
          Logger.info('Updated', res);
          resolve();
        }).catch((err) => {
          Logger.error('error updating', err);
          reject(Error('Error updating info'));
        });
    }).catch((err) => {
      Logger.error(err);
      reject(Error('Internal server error'));
    });
  });

  const UpdatePasswordMnemonic = (user, currentPassword, newPassword, newSalt, mnemonic, privateKey) => new Promise((resolve, reject) => {
    FindUserByEmail(user).then((userData) => {
      const storedPassword = userData.password.toString();
      if (storedPassword !== currentPassword) {
        Logger.error('Invalid password');
        reject(Error('Invalid password'));
      } else {
        resolve();

        Model.users
          .update({
            password: newPassword,
            mnemonic,
            hKey: newSalt
          }, { where: { email: { [Op.eq]: user } } }).then((res) => {
            updatePrivateKey(user, privateKey);
            Logger.info('Updated', res);
            resolve();
          }).catch((err) => {
            Logger.error('error updating', err);
            reject(Error('Error updating info'));
          });
      }
    }).catch((err) => {
      Logger.error(err);
      reject(Error('Internal server error'));
    });
  });

  const LoginFailed = (user, loginFailed) => Model.users.update({
    errorLoginCount: loginFailed ? sequelize.literal('error_login_count + 1') : 0
  }, { where: { email: user } });

  const ResendActivationEmail = (user) => axios.post(`${process.env.STORJ_BRIDGE}/activations`, { email: user });

  const UpdateAccountActivity = (user) => Model.users.update({ updated_at: new Date() }, { where: { email: user } });

  const getSyncDate = () => {
    let syncDate = Date.now();
    syncDate += SYNC_KEEPALIVE_INTERVAL_MS;

    return new Date(syncDate);
  };

  const hasUserSyncEnded = (sync) => {
    if (!sync) {
      return true;
    }

    const now = Date.now();
    const syncTime = sync.getTime();

    return now - syncTime > SYNC_KEEPALIVE_INTERVAL_MS;
  };

  const GetUserSync = async (user) => {
    const userSyncDate = await Model.users.findOne({
      where: { email: { [Op.eq]: user } },
      attributes: ['syncDate'],
      raw: true
    });

    return userSyncDate.syncDate;
  };

  const GetUserBucket = (userObject) => Model.folder.findOne({
    where: {
      id: { [Op.eq]: userObject.root_folder_id }
    },
    attributes: ['bucket']
  }).then((folder) => folder.bucket).catch(() => null);

  // TODO: Check transaction is actually running
  const UpdateUserSync = async (user, toNull) => {
    let sync = null;
    if (!toNull) {
      sync = getSyncDate();
    }

    await Model.users.update({ syncDate: sync }, { where: { email: user } });

    return sync;
  };

  const GetOrSetUserSync = async (user) => {
    const currentSync = await GetUserSync(user);
    const userSyncEnded = hasUserSyncEnded(currentSync);
    if (!currentSync || userSyncEnded) {
      await UpdateUserSync(user, false);
    }

    return !userSyncEnded;
  };

  const UnlockSync = (user) => {
    user.syncDate = null;
    return user.save();
  };

  const ActivateUser = (token) => axios.get(`${App.config.get('STORJ_BRIDGE')}/activations/${token}`);

  return {
    Name: 'User',
    FindOrCreate,
    UpdateMnemonic,
    UpdateStorageOption,
    GetUserById,
    FindUserByEmail,
    FindUserObjByEmail,
    FindUserByUuid,
    FindUsersByReferred,
    InitializeUser,
    GetUserCredit,
    GetUsersRootFolder,
    UpdateCredit,
    DecrementCredit,
    DeactivateUser,
    ConfirmDeactivateUser,
    Store2FA,
    Delete2FA,
    UpdatePasswordMnemonic,
    LoginFailed,
    ResendActivationEmail,
    UpdateAccountActivity,
    GetOrSetUserSync,
    UpdateUserSync,
    UnlockSync,
    ActivateUser,
    GetUserBucket
  };
};
