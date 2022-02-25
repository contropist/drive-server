import { Request, Response, Router } from 'express';
import sharedMiddlewareBuilder from '../middleware/shared-workspace';
import passport from '../middleware/passport';
import { UserAttributes } from '../models/user';
import { Logger } from 'winston';
import { default as logger } from '../../lib/logger';
import { ReferralsNotAvailableError } from '../services/errors/referrals';
import createHttpError from 'http-errors';
import { FolderAttributes } from '../models/folder';
import teamsMiddlewareBuilder from '../middleware/teams';
import Validator from '../../lib/Validator';
import { FileAttributes } from '../models/file';

interface Services {
  Files: any
  Folder: any
  UsersReferrals: any
  Analytics: any
  User: any
  Notifications: any
  Share: any
}

type SharedRequest = Request & { behalfUser: UserAttributes };
type PassportRequest = Request & { user: UserAttributes };

export class StorageController {
  private services: Services;
  private logger: Logger;

  constructor(services: Services, logger: Logger) {
    this.services = services;
    this.logger = logger;
  }

  public async createFile(req: Request, res: Response) {
    const { behalfUser } = req as SharedRequest;
    const { file } = req.body;
    const internxtClient = req.headers['internxt-client'];
    const clientId = String(req.headers['internxt-client-id']);

    if (!file.fileId && file.file_id) {
      // TODO : Remove WHEN every project uses the SDK
      file.fileId = file.file_id;
    }

    if (!file || !file.fileId || !file.bucket || !file.size || !file.folder_id || !file.name) {
      this.logger.error(
        `Invalid metadata trying to create a file for user ${behalfUser.email}: ${JSON.stringify(file, null, 2)}`
      );
      return res.status(400).json({ error: 'Invalid metadata for new file' });
    }

    const result = await this.services.Files.CreateFile(behalfUser, file);

    // TODO: If user has referrals, then apply. Do not catch everything
    if (internxtClient === 'drive-mobile') {
      this.services.UsersReferrals.applyUserReferral(behalfUser.id, 'install-mobile-app')
        .catch((err: Error) => {
          this.logReferralError(behalfUser.id, err);
        });
    }

    if (internxtClient === 'drive-desktop') {
      this.services.UsersReferrals.applyUserReferral(behalfUser.id, 'install-desktop-app')
        .catch((err: Error) => {
          this.logReferralError(behalfUser.id, err);
        });
    }

    res.status(200).json(result);

    const workspaceMembers = await this.services.User.findWorkspaceMembers(behalfUser.bridgeUser);

    workspaceMembers.forEach(
      ({ email }: { email: string }) => void this.services.Notifications.fileCreated({
        file: result,
        email: email,
        clientId: clientId
      }),
    );

    this.services.Analytics.trackUploadCompleted(req, behalfUser);
  }

  public async createFolder(req: Request, res: Response): Promise<void> {
    const { folderName, parentFolderId } = req.body;
    const { user } = req as PassportRequest;

    if (Validator.isInvalidString(folderName)) {
      throw createHttpError(400, 'Folder name must be a valid string');
    }

    if (!parentFolderId || parentFolderId <= 0) {
      throw createHttpError(400, 'Parent folder ID is not valid');
    }

    const clientId = String(req.headers['internxt-client-id']);

    return this.services.Folder.Create(user, folderName, parentFolderId)
      .then(async (result: FolderAttributes) => {
        res.status(201).json(result);
        const workspaceMembers = await this.services.User.findWorkspaceMembers(user.bridgeUser);
        workspaceMembers.forEach(
          ({ email }: { email: string }) => void this.services.Notifications.folderCreated({
            folder: result,
            email: email,
            clientId: clientId
          })
        );
      })
      .catch((err: Error) => {
        this.logger.warn(err);
        res.status(500).json({ error: err.message });
      });
  }

  public async getTree(req: Request, res: Response): Promise<void> {
    const { user } = req as PassportRequest;

    return this.services.Folder.GetTree(user)
      .then((result: unknown) => {
        res.status(200).send(result);
      })
      .catch((err: Error) => {
        res.status(500).send({
          error: err.message
        });
      });
  }

  public async getTreeSpecific(req: Request, res: Response): Promise<void> {
    const { user } = req as PassportRequest;
    const { folderId } = req.params;

    if (Validator.isInvalidPositiveNumber(folderId)) {
      throw createHttpError(400, 'Folder ID not valid');
    }

    return this.services.Folder.GetTree(user, folderId)
      .then((result: unknown) => {
        const treeSize = this.services.Folder.GetTreeSize(result);
        res.status(200).send({
          tree: result,
          size: treeSize
        });
      })
      .catch((err: Error) => {
        res.status(500).send({
          error: err.message
        });
      });
  }

  public async deleteFolder(req: Request, res: Response): Promise<void> {
    const { behalfUser: user } = req as SharedRequest;

    const folderId = Number(req.params.id);
    if (Validator.isInvalidPositiveNumber(folderId)) {
      throw createHttpError(400, 'Folder ID param is not valid');
    }

    const clientId = String(req.headers['internxt-client-id']);

    return this.services.Folder.Delete(user, folderId)
      .then(async (result: unknown) => {
        res.status(204).send(result);
        const workspaceMembers = await this.services.User.findWorkspaceMembers(user.bridgeUser);
        workspaceMembers.forEach(
          ({ email }: { email: string }) => void this.services.Notifications.folderDeleted({
            id: folderId,
            email: email,
            clientId: clientId,
          }),
        );
      })
      .catch((err: Error) => {
        this.logger.error(`${err.message}\n${err.stack}`);
        res.status(500).send({ error: err.message });
      });
  }

  public async moveFolder(req: Request, res: Response): Promise<void> {
    const { behalfUser: user } = req as SharedRequest;
    const { folderId, destination } = req.body;

    if (Validator.isInvalidPositiveNumber(folderId)) {
      throw createHttpError(400, 'Folder ID is not valid');
    }

    if (Validator.isInvalidPositiveNumber(destination)) {
      throw createHttpError(400, 'Destination folder ID is not valid');
    }

    const clientId = String(req.headers['internxt-client-id']);

    return this.services.Folder.MoveFolder(user, folderId, destination)
      .then(async (result: { result: FolderAttributes }) => {
        res.status(200).json(result);
        const workspaceMembers = await this.services.User.findWorkspaceMembers(user.bridgeUser);
        workspaceMembers.forEach(
          ({ email }: { email: string }) => void this.services.Notifications.folderUpdated({
            folder: result.result,
            email: email,
            clientId: clientId
          }),
        );
      })
      .catch((err: Error) => {
        res.status(500).json({
          error: err.message
        });
      });
  }

  public async updateFolder(req: Request, res: Response): Promise<void> {
    const { behalfUser: user } = req as SharedRequest;
    const folderId = req.params.folderid;
    const { metadata } = req.body;

    if (Validator.isInvalidPositiveNumber(folderId)) {
      throw createHttpError(400, 'Folder ID is not valid');
    }

    const clientId = String(req.headers['internxt-client-id']);

    return this.services.Folder.UpdateMetadata(user, folderId, metadata)
      .then(async (result: FolderAttributes) => {
        res.status(200).json(result);
        const workspaceMembers = await this.services.User.findWorkspaceMembers(user.bridgeUser);
        workspaceMembers.forEach(
          ({ email }: { email: string }) => void this.services.Notifications.folderUpdated({
            folder: result,
            email: email,
            clientId: clientId
          }),
        );
      })
      .catch((err: Error) => {
        this.logger.error(`Error updating metadata from folder ${folderId}: ${err}`);
        res.status(500).json(err.message);
      });
  }

  public async getFolderContents(req: Request, res: Response): Promise<void> {
    const { behalfUser } = req as SharedRequest;
    const { id } = req.params;

    if (Validator.isInvalidPositiveNumber(id)) {
      throw createHttpError(400, 'Folder ID is not valid');
    }

    return Promise.all([
      this.services.Folder.getById(id),
      this.services.Folder.getFolders(id, behalfUser.id),
      this.services.Files.getByFolderAndUserId(id, behalfUser.id),
    ])
      .then(([currentFolder, childrenFolders, childrenFiles]) => {
        if (!currentFolder || !childrenFolders || !childrenFiles) {
          res.status(400).send();
        }

        res.status(200).json({
          ...currentFolder,
          children: childrenFolders,
          files: childrenFiles,
        });
      })
      .catch((err) => {
        res.status(500).json({ error: err.message });
      });
  }

  public async getFolderSize(req: Request, res: Response): Promise<void> {
    const { user } = req as PassportRequest;
    const folderId = req.params.id;

    if (Validator.isInvalidPositiveNumber(folderId)) {
      throw createHttpError(400, 'Folder ID is not valid');
    }

    const size = await this.services.Share.getFolderSize(folderId, user.id);

    res.status(200).json({
      size: size,
    });
  }

  public async moveFile(req: Request, res: Response): Promise<void> {
    const { behalfUser: user } = req as SharedRequest;
    const { fileId, destination } = req.body;

    if (Validator.isInvalidPositiveNumber(fileId)) {
      throw createHttpError(400, 'File ID is not valid');
    }

    if (Validator.isInvalidPositiveNumber(destination)) {
      throw createHttpError(400, 'Destination folder ID is not valid');
    }

    const clientId = String(req.headers['internxt-client-id']);

    return this.services.Files.MoveFile(user, fileId, destination)
      .then(async (result: { result: FileAttributes }) => {
        res.status(200).json(result);
        const workspaceMembers = await this.services.User.findWorkspaceMembers(user.bridgeUser);
        workspaceMembers.forEach(
          ({ email }: { email: string }) => void this.services.Notifications.fileUpdated({
            file: result.result,
            email: email,
            clientId: clientId
          }),
        );
      })
      .catch((err: Error) => {
        this.logger.error(err);
        res.status(500).json({
          error: err.message
        });
      });
  }

  private logReferralError(userId: unknown, err: Error) {
    if (!err.message) {
      return this.logger.error('[STORAGE]: ERROR message undefined applying referral for user %s', userId);
    }

    if (err instanceof ReferralsNotAvailableError) {
      return;
    }

    return this.logger.error('[STORAGE]: ERROR applying referral for user %s: %s', userId, err.message);
  };
}

export default (router: Router, service: any) => {
  const Logger = logger.getInstance();
  const { passportAuth } = passport;
  const sharedAdapter = sharedMiddlewareBuilder.build(service);
  const teamsAdapter = teamsMiddlewareBuilder.build(service);
  const controller = new StorageController(service, Logger);

  router.post('/storage/file', passportAuth, sharedAdapter,
    controller.createFile.bind(controller)
  );
  router.post('/storage/folder', passportAuth,
    controller.createFolder.bind(controller)
  );
  router.get('/storage/tree', passportAuth,
    controller.getTree.bind(controller)
  );
  router.get('/storage/tree/:folderId', passportAuth,
    controller.getTreeSpecific.bind(controller)
  );
  router.delete('/storage/folder/:id', passportAuth, sharedAdapter,
    controller.deleteFolder.bind(controller)
  );
  router.post('/storage/move/folder', passportAuth, sharedAdapter,
    controller.moveFolder.bind(controller)
  );
  router.post('/storage/folder/:folderid/meta', passportAuth, sharedAdapter,
    controller.updateFolder.bind(controller)
  );
  router.get('/storage/v2/folder/:id/:idTeam?', passportAuth, sharedAdapter, teamsAdapter,
    controller.getFolderContents.bind(controller)
  );
  router.get('/storage/folder/size/:id', passportAuth,
    controller.getFolderSize.bind(controller)
  );
  router.post('/storage/move/file', passportAuth, sharedAdapter,
    controller.moveFile.bind(controller)
  );

};
