import axios from 'axios';
import crypto from 'crypto';
const sequelize = require('sequelize');
const bip39 = require('bip39');
const { request } = require('@internxt/lib');
const AnalyticsService = require('../../lib/analytics/AnalyticsService');
const KeyServerService = require('./keyserver');
const CryptService = require('./crypt');
const createHttpError = require('http-errors');
const uuid = require('uuid');

const MailService = require('./mail');
const passport = require('../middleware/passport');
const { SYNC_KEEPALIVE_INTERVAL_MS } = require('../constants');
const Logger = require('../../lib/logger').default;

const { Op, col, fn } = sequelize;

module.exports = (Model, App) => {
  const logger = Logger.getInstance();
  const KeyServer = KeyServerService(Model, App);
  const CryptServiceInstance = CryptService(Model, App);
  const mailService = MailService(Model, App);

  const FindOrCreate = (user) => {
    // Create password hashed pass only when a pass is given
    const userPass = user.password ? App.services.Crypt.decryptText(user.password) : null;
    const userSalt = user.salt ? App.services.Crypt.decryptText(user.salt) : null;

    // Throw error when user email. pass, salt or mnemonic is missing
    if (!user.email || !userPass || !userSalt || !user.mnemonic) {
      throw Error('Wrong user registration data');
    }

    return Model.users.sequelize.transaction(async (t) =>
      Model.users
        .findOrCreate({
          where: { username: user.email },
          defaults: {
            email: user.email,
            name: user.name,
            lastname: user.lastname,
            password: userPass,
            mnemonic: user.mnemonic,
            hKey: userSalt,
            referrer: user.referrer,
            referralCode: uuid.v4(),
            uuid: null,
            credit: user.credit,
            welcomePack: true,
            registerCompleted: user.registerCompleted,
            username: user.username,
            bridgeUser: user.bridgeUser,
          },
          transaction: t,
        })
        .then(async ([userResult, isNewRecord]) => {
          if (isNewRecord) {
            if (user.publicKey && user.privateKey && user.revocationKey) {
              Model.keyserver.findOrCreate({
                where: { user_id: userResult.id },
                defaults: {
                  user_id: user.id,
                  private_key: user.privateKey,
                  public_key: user.publicKey,
                  revocation_key: user.revocationKey,
                  encrypt_version: null,
                },
                transaction: t,
              });
            }

            // Create bridge pass using email (because id is unconsistent)
            const bcryptId = await App.services.Inxt.IdToBcrypt(userResult.email);

            const bridgeUser = await App.services.Inxt.RegisterBridgeUser(userResult.email, bcryptId);
            if (
              bridgeUser &&
              bridgeUser.response &&
              (bridgeUser.response.status === 500 || bridgeUser.response.status === 400)
            ) {
              throw Error(bridgeUser.response.data.error);
            }

            if (!bridgeUser.data) {
              throw Error('Error creating bridge user');
            }

            logger.info('User Service | created brigde user: %s', userResult.email);

            // Store bcryptid on user register
            await userResult.update(
              {
                userId: bcryptId,
                uuid: bridgeUser.data.uuid,
              },
              { transaction: t },
            );

            // Set created flag for Frontend management
            Object.assign(userResult, { isNewRecord });
          }

          // TODO: proveriti userId kao pass
          return userResult;
        })
        .catch((err) => {
          if (err.response) {
            // This happens when email is registered in bridge
            logger.error(err.response.data);
          } else {
            logger.error(err.stack);
          }

          throw Error(err);
        }),
    ); // end transaction
  };

  const InitializeUser = (user) =>
    Model.users.sequelize.transaction((t) =>
      Model.users.findOne({ where: { username: { [Op.eq]: user.email } } }).then(async (userData) => {
        if (userData.root_folder_id) {
          userData.mnemonic = user.mnemonic;

          return userData;
        }

        const { Inxt, Crypt } = App.services;
        const rootBucket = await Inxt.CreateBucket(userData.email, userData.userId, user.mnemonic);
        logger.info('User init | root bucket created %s', rootBucket.name);

        const rootFolderName = await Crypt.encryptName(`${rootBucket.name}`);
        const rootFolder = await userData.createFolder({
          name: rootFolderName,
          bucket: rootBucket.id,
        });

        logger.info('User init | root folder created, id: %s', rootFolder.id);

        // Update user register with root folder Id
        await userData.update({ root_folder_id: rootFolder.id }, { transaction: t });

        // Set decrypted mnemonic to returning object
        const updatedUser = userData;
        updatedUser.mnemonic = user.mnemonic;
        updatedUser.bucket = rootBucket.id;

        return updatedUser;
      }),
    );

  const FindUserByEmail = (email) =>
    new Promise((resolve, reject) => {
      Model.users
        .findOne({ where: { username: { [Op.eq]: email } } })
        .then((userData) => {
          if (!userData) {
            logger.error('ERROR user %s not found on database', email);
            return reject(Error('Wrong email/password'));
          }

          const user = userData.dataValues;

          if (user.mnemonic) {
            user.mnemonic = user.mnemonic.toString();
          }

          return resolve(user);
        })
        .catch((err) => reject(err));
    });

  const findById = (id) => Model.users.findOne({ where: { id } });

  const FindUserByUuid = (userUuid) => Model.users.findOne({ where: { uuid: { [Op.eq]: userUuid } } });

  const FindUserObjByEmail = (email) => Model.users.findOne({ where: { username: { [Op.eq]: email } } });

  const deactivate = async (email) => {
    const user = await Model.users.findOne({ where: { username: { [Op.eq]: email } } });

    if (!user) {
      throw new Error('User not found');
    }

    const pass = crypto.createHash('sha256').update(user.userId).digest('hex');
    const auth = Buffer.from(`${user.email}:${pass}`).toString('base64');
    const deactivator = crypto.randomBytes(256).toString('hex');
    const deactivationUrl = `${process.env.HOST_DRIVE_WEB}/deactivations/${deactivator}`;

    return sendDeactivateEmail(auth, email, deactivationUrl, deactivator);
  };

  const sendDeactivateEmail = (auth, email, deactivationUrl, deactivator) => {
    const host = App.config.get('STORJ_BRIDGE');

    return axios
      .delete(`${host}/users/${email}?redirect=${deactivationUrl}&deactivator=${deactivator}`, {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
      })
      .catch((err) => {
        throw new Error(request.extractMessageFromError(err));
      });
  };

  const confirmDeactivate = async (token) => {
    let user;

    try {
      const userEmail = await axios
        .get(`${App.config.get('STORJ_BRIDGE')}/deactivationStripe/${token}`, {
          headers: { 'Content-Type': 'application/json' },
        })
        .then((res) => {
          return res.data.email;
        });

      user = await Model.users.findOne({ where: { username: userEmail } });

      if (!user) {
        throw new Error('User not found');
      }

      // DELETE FOREIGN KEYS (not cascade)
      user.root_folder_id = null;
      await user.save();
      const keys = await user.getKeyserver();
      if (keys) {
        await keys.destroy();
      }

      const appSumo = await user.getAppSumo();
      if (appSumo) {
        await appSumo.destroy();
      }

      await Model.backup.destroy({ where: { userId: user.id } });
      await Model.device.destroy({ where: { userId: user.id } });

      await user.destroy();

      logger.info('User %s confirmed deactivation', userEmail);
    } catch (err) {
      if (user) {
        const tempUsername = `${user.email}-${crypto.randomBytes(5).toString('hex')}-DELETED`;

        user.email = tempUsername;
        user.username = tempUsername;
        user.bridgeUser = tempUsername;
        await user.save();

        throw new Error(`Deactivation error for user ${user.email} (renamed to ${tempUsername}): ${err.message}`);
      } else {
        throw new Error(err.message);
      }
    }
  };

  const Store2FA = (user, key) => Model.users.update({ secret_2FA: key }, { where: { username: { [Op.eq]: user } } });

  const Delete2FA = (user) => Model.users.update({ secret_2FA: null }, { where: { username: { [Op.eq]: user } } });

  const updatePrivateKey = (user, privateKey) => {
    return Model.keyserver.update(
      {
        private_key: privateKey,
      },
      {
        where: { user_id: { [Op.eq]: user.id } },
      },
    );
  };

  const UpdatePasswordMnemonic = async (user, currentPassword, newPassword, newSalt, mnemonic, privateKey) => {
    const storedPassword = user.password.toString();
    if (storedPassword !== currentPassword) {
      throw Error('Invalid password');
    }

    await Model.users.update(
      {
        password: newPassword,
        mnemonic,
        hKey: newSalt,
      },
      {
        where: { username: { [Op.eq]: user.email } },
      },
    );

    await updatePrivateKey(user, privateKey);
  };

  const recoverPassword = async (user, newPassword, newSalt, oldMnemonic, oldPrivateKey) => {
    // Update password, salt & mnemonic
    user.hKey = newSalt;
    user.mnemonic = oldMnemonic;
    user.password = newPassword;
    await user.save();

    const keys = await user.getKeyserver();
    if (!oldPrivateKey) {
      keys.destroy();
    } else {
      keys.private_key = oldPrivateKey;
      await keys.save().catch(() => {
        // eslint-disable-next-line no-empty
      });
    }
  };

  const LoginFailed = (user, loginFailed) =>
    Model.users.update(
      {
        errorLoginCount: loginFailed ? sequelize.literal('error_login_count + 1') : 0,
      },
      { where: { username: user } },
    );

  const ResendActivationEmail = (user) => axios.post(`${process.env.STORJ_BRIDGE}/activations`, { email: user });

  const UpdateAccountActivity = (user) => Model.users.update({ updated_at: new Date() }, { where: { username: user } });

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

  const GetUserBucket = (userObject) =>
    Model.folder
      .findOne({
        where: { id: { [Op.eq]: userObject.root_folder_id } },
        attributes: ['bucket'],
      })
      .then((folder) => folder.bucket)
      .catch(() => null);

  const UpdateUserSync = async (user, toNull) => {
    let sync = null;
    if (!toNull) {
      sync = getSyncDate();
    }

    try {
      await Model.users.update({ syncDate: sync }, { where: { username: user.email } });
    } catch (err) {
      logger.error(err);
      throw Error('Internal server error');
    }

    return sync;
  };

  const GetOrSetUserSync = async (user) => {
    const currentSync = user.syncDate;
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

  const RegisterUser = async (newUserData) => {
    logger.warn('Register request for %s', newUserData.email);

    if (!(newUserData.email && newUserData.password)) {
      throw createHttpError(400, 'You must provide registration data');
    }

    const hasReferrer = !!newUserData.referrer;
    const referrer = hasReferrer
      ? await Model.users.findOne({ where: { referralCode: { [Op.eq]: newUserData.referrer } } })
      : null;

    if (hasReferrer && !referrer) {
      throw createHttpError(400, 'The referral code used is not correct');
    }

    const email = newUserData.email.toLowerCase().trim();
    const userData = await FindOrCreate({
      ...newUserData,
      email,
      username: email,
      bridgeUser: email,
      credit: 0,
    });

    if (!userData) {
      throw Error('User can not be created');
    }

    if (!userData.isNewRecord) {
      throw Error('This account already exists');
    }

    if (hasReferrer) {
      AnalyticsService.trackInvitationAccepted(userData.uuid, referrer.uuid, referrer.email);

      await App.services.UsersReferrals.applyUserReferral(referrer.id, 'invite-friends');
    }

    // Successfull register
    const token = passport.Sign(userData.email, App.config.get('secrets').JWT);

    // Creates user referrals
    await App.services.UsersReferrals.createUserReferrals(userData.id);

    const user = {
      userId: userData.userId,
      mnemonic: userData.mnemonic,
      root_folder_id: userData.root_folder_id,
      name: userData.name,
      lastname: userData.lastname,
      uuid: userData.uuid,
      credit: userData.credit,
      createdAt: userData.createdAt,
      registerCompleted: userData.registerCompleted,
      email: userData.email,
      username: userData.username,
      bridgeUser: userData.bridgeUser,
      sharedWorkspace: userData.sharedWorkspace,
      appSumoDetails: null,
      hasReferralsProgram: true,
      backupsBucket: userData.backupsBucket,
      referralCode: userData.referralCode,
    };

    try {
      const keys = await KeyServer.getKeys(userData);
      user.privateKey = keys.private_key;
      user.publicKey = keys.public_key;
      user.revocationKey = keys.revocation_key;
    } catch (e) {
      // no op
    }

    return { token, user, uuid: userData.uuid };
  };

  const updateKeys = async (user, data) => {
    if (!data.privateKey) {
      throw new Error('No Private key provided');
    }

    if (!data.publicKey) {
      throw new Error('No Public key provided');
    }

    if (!data.revocationKey) {
      throw new Error('No Revocation key provided');
    }

    const userKeys = await user.getKeyserver();

    userKeys.private_key = data.privateKey;
    userKeys.public_key = data.publicKey;
    userKeys.revocation_key = data.revocationKey;

    return userKeys.save();
  };

  const getUsage = async (user) => {
    const targetUser = await Model.users.findOne({ where: { username: user.bridgeUser } });
    const usage = await Model.folder.findAll({
      where: { user_id: targetUser.id },
      include: [{ model: Model.file, attributes: [] }],
      attributes: [[fn('sum', col('size')), 'total']],
      raw: true,
    });

    const driveUsage = usage[0].total;

    const backupsQuery = await Model.backup.findAll({
      where: { userId: targetUser.id },
      attributes: [[fn('sum', col('size')), 'total']],
      raw: true,
    });

    const backupsUsage = backupsQuery[0].total ? backupsQuery[0].total : 0;

    return {
      total: driveUsage + backupsUsage,
      _id: user.email,
      drive: driveUsage || 0,
      backups: backupsUsage,
    };
  };

  const UpdateUserStorage = async (email, maxSpaceBytes) => {
    const { GATEWAY_USER, GATEWAY_PASS } = process.env;

    return axios.post(
      `${process.env.STORJ_BRIDGE}/gateway/upgrade`,
      {
        email,
        bytes: parseInt(maxSpaceBytes, 10),
      },
      {
        headers: { 'Content-Type': 'application/json' },
        auth: { username: GATEWAY_USER, password: GATEWAY_PASS },
      },
    );
  };

  const CreateStaggingUser = async (email) => {
    const randomPassword = CryptServiceInstance.RandomPassword(email);
    const encryptedPassword = CryptServiceInstance.passToHash({ password: randomPassword });

    const encryptedHash = CryptServiceInstance.encryptText(encryptedPassword.hash);
    const encryptedSalt = CryptServiceInstance.encryptText(encryptedPassword.salt);

    const newMnemonic = bip39.generateMnemonic(256);
    const encryptedMnemonic = CryptServiceInstance.encryptTextWithKey(newMnemonic, randomPassword);

    const userObject = {
      email,
      name: null,
      lastname: null,
      password: encryptedHash,
      mnemonic: encryptedMnemonic,
      salt: encryptedSalt,
      referral: null,
      uuid: null,
      credit: 0,
      welcomePack: true,
      registerCompleted: false,
      username: email,
      sharedWorkspace: false,
      bridgeUser: email,
    };

    const user = await FindOrCreate(userObject);
    return user;
  };

  const invite = async ({ inviteEmail, hostEmail, hostFullName, hostReferralCode }) => {
    const userToInvite = await Model.users.findOne({ where: { email: inviteEmail } });

    if (userToInvite) {
      throw createHttpError(409, `Email ${inviteEmail} is already registered`);
    }

    await mailService.sendInviteFriendMail(inviteEmail, {
      inviteEmail,
      hostEmail,
      hostFullName,
      registerUrl: `${process.env.HOST_DRIVE_WEB}/new?ref=${hostReferralCode}`,
    });
  };

  const CompleteInfo = async (user, info) => {
    if (user.registerCompleted) {
      throw Error('User info is up to date');
    }
    const cPassword = CryptServiceInstance.RandomPassword(user.email);
    const cSalt = user.hKey.toString();
    const hashedCurrentPassword = CryptServiceInstance.passToHash({ password: cPassword, salt: cSalt }).hash;

    const newPassword = CryptServiceInstance.decryptText(info.password);
    const newSalt = CryptServiceInstance.decryptText(info.salt);

    user.name = info.name;
    user.lastname = info.lastname;
    // user.registerCompleted = true;
    await user.save();
    await UpdatePasswordMnemonic(user, hashedCurrentPassword, newPassword, newSalt, info.mnemonic);

    // Finish
    user.registerCompleted = true;
    user.sharedWorkspace = false;
    return user.save();
  };

  const findWorkspaceMembers = async (bridgeUser) => {
    return Model.users.findAll({ where: { bridgeUser } });
  };

  return {
    Name: 'User',
    FindOrCreate,
    RegisterUser,
    findById,
    FindUserByEmail,
    FindUserObjByEmail,
    FindUserByUuid,
    InitializeUser,
    Store2FA,
    Delete2FA,
    UpdatePasswordMnemonic,
    LoginFailed,
    ResendActivationEmail,
    UpdateAccountActivity,
    GetOrSetUserSync,
    UpdateUserSync,
    UnlockSync,
    GetUserBucket,
    UpdateUserStorage,
    CreateStaggingUser,
    CompleteInfo,
    getUsage,
    updateKeys,
    recoverPassword,
    invite,
    deactivate,
    confirmDeactivate,
    findWorkspaceMembers,
  };
};
