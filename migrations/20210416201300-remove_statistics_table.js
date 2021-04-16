module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.dropTable('statistics');
  },

  down: (queryInterface, Sequelize) => {
    return Promise.all([
      queryInterface.createTable('statistics', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          allowNull: false,
          autoIncrement: true
        },
        name: {
          type: Sequelize.STRING
        },
        user: {
          type: Sequelize.STRING
        },
        user_agent: {
          type: Sequelize.STRING
        },
        created_at: {
          type: Sequelize.DATE
        },
        updated_at: {
          type: Sequelize.DATE
        },
        action: {
          type: Sequelize.STRING(40)
        }
      })
    ]);
  }
};
