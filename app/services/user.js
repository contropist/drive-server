const { mnemonicGenerate } = require('storj');
const crypto = require('crypto')

module.exports = (Model, App) => {
  const logger = App.logger;

  const FindOrCreate = (user) => {
    // Create password hashed pass only when a pass is given
    const userPass = user.password ? App.services.Crypt.encryptName(user.password) : null;

    return Model.users.sequelize.transaction(function (t) {
      return Model.users.findOrCreate({
        where: { email: user.email },
        defaults: {
          name: user.name,
          lastname: user.lastname,
          password: userPass
        },
        transaction: t
      }).spread(async function (userResult, created) {
        if (created) {
          // Create bridge pass using email (because id is unconsistent)
          const bcryptId = await App.services.Storj.IdToBcrypt(userResult.email)

          const bridgeUser = await App.services.Storj
            .RegisterBridgeUser(userResult.email, bcryptId)
          if (!bridgeUser.data) { throw new Error('Error creating bridge user') }
          logger.info('User Service | created brigde user')

          const freeTier = bridgeUser.data ? bridgeUser.data.isFreeTier : 1;
          // Store bcryptid on user register
          await userResult.update({
            userId: bcryptId,
            isFreeTier: freeTier
          }, { transaction: t });

          // Set created flag for Frontend management
          Object.assign(userResult, { isCreated: created })

          return userResult;
        } else {
          // TODO: proveriti userId kao pass
          // const isValid = bcrypt.compareSync(user.userId, userResult.userId)
          //const isValid = true;
          //if (isValid) return userResult;
          //throw new Error('User invalid')
          return userResult;
        }
      }).catch((err) => {
        if (err.response) {
          // This happens when email is registered in bridge
          logger.error(err.response.data);
        } else {
          logger.error(err.stack);
        }
        throw new Error(err)
      })
    }) // end transaction
  }

  const InitializeUser = (user) => {
    return Model.users.sequelize.transaction(function (t) {
      return Model.users.findOne({ where: { email: user.email } })
        .then(async (userData) => {
          const bcryptId = userData.userId;

          const userMnemonic = mnemonicGenerate(256)
          logger.info('User init | mnemonic generated')

          const rootBucket = await App.services.Storj
            .CreateBucket(userData.email, bcryptId, userMnemonic)
          logger.info('User init | root bucket created')

          const rootFolderName = await App.services.Crypt.encryptName(`${userData.email}_root`)
          logger.info('User init | root folder name: ' + rootFolderName)

          const rootFolder = await userData.createFolder({
            name: rootFolderName,
            bucket: rootBucket.id
          })
          logger.info('User init | root folder created')

          // Update user register with root folder Id
          await userData.update({
            root_folder_id: rootFolder.id,
            mnemonic: userMnemonic
          }, { transaction: t });

          /**
           * On return mnemonic to user. He needs to decide if he will preserve it in DB
           */
          Object.assign(userData, { mnemonic: userMnemonic });
          return userData
        }).catch((error) => {
          logger.error(error.stack);
          throw new Error(error);
        })
    })
  }

  const UpdateMnemonic = async (userId, mnemonic) => {
    const found = Model.users.findById(userId);
    if (found) {
      try {
        const user = await Model.users.update(
          { mnemonic },
          { where: { id: userId }, validate: true }
        );
        return user
      } catch (errorResponse) {
        throw new Error(errorResponse);
      }
    }
  }

  const GetUserById = id => Model.users.findOne({ where: { id } })
    .then((response) => {
      return response.dataValues
    })

  const FindUserByEmail = email => Model.users.findOne({ where: { email } })
    .then((userData) => {
      return userData.dataValues
    })

  const GetUsersRootFolder = id => Model.users.findAll({
    include: [Model.folder]
  }).then(user => user.dataValues)

  return {
    Name: 'User',
    FindOrCreate,
    UpdateMnemonic,
    GetUserById,
    FindUserByEmail,
    InitializeUser,
    GetUsersRootFolder
  }
}
