# Drive Server

## Prerrequisites

* Node v10

  ```nvm install v10```
  
  (Cannot be upgraded to higher version until [node-lib](https://github.com/internxt/node-lib) bindings fixed).

* Yarn

  ```npm i -g yarn```

* PM2

  ```npm i -g pm2```

* Node-gyp essentials

  Ubuntu: ```sudo apt install python build-essential```

  Windows: ```npm i -g windows-build-tools```

  Mac: ```xcode-select --install```

# Install

- Create a `.npmrc` file from the `.npmrc.template` example provided in the repo. 
- Replace `TOKEN` with your own [Github Personal Access Token](https://docs.github.com/en/github/authenticating-to-github/keeping-your-account-and-data-secure/creating-a-personal-access-token) with `read:packages` permission **ONLY**
- Use `yarn` to install project dependencies.

#### Database setup (MariaDB)

Create schema and configure `config/environments/development.json`

Run `yarn run migrate` to create tables.

#### Start app

Run `yarn start` to start server in production mode.

Run `yarn run dev` to start with nodemon and development environment.
