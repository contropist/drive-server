import axios from 'axios';
import { FileAttributes } from '../../app/models/file';
import { FolderAttributes } from '../../app/models/folder';
import { UserAttributes } from '../../app/models/user';
import Logger from '../../lib/logger';

type RequestData = {
  event: string;
  payload: Record<string, any>;
  email?: string;
  clientId: string;
  userId?: UserAttributes['uuid'];
};

export default class Notifications {
  private static instance: Notifications;

  static getInstance(): Notifications {
    if (Notifications.instance) {
      return Notifications.instance;
    }

    if (!process.env.NOTIFICATIONS_API_KEY || !process.env.NOTIFICATIONS_URL)
      Logger.getInstance().warn('NOTIFICATIONS env variables must be defined');

    Notifications.instance = new Notifications();

    return Notifications.instance;
  }

  fileCreated({
    file,
    uuid,
    clientId,
  }: { file: FileAttributes, uuid: RequestData['userId'] } & Pick<RequestData, 'clientId'>): Promise<void> {
    return this.post({ event: 'FILE_CREATED', payload: file, userId: uuid, clientId });
  }

  fileUpdated({
    file,
    email,
    clientId,
  }: { file: FileAttributes } & Pick<RequestData, 'email' | 'clientId'>): Promise<void> {
    return this.post({ event: 'FILE_UPDATED', payload: file, email, clientId });
  }

  fileDeleted({ id, email, clientId }: { id: number } & Pick<RequestData, 'email' | 'clientId'>): Promise<void> {
    return this.post({ event: 'FILE_DELETED', payload: { id }, email, clientId });
  }

  folderCreated({
    folder,
    email,
    clientId,
  }: { folder: FolderAttributes } & Pick<RequestData, 'email' | 'clientId'>): Promise<void> {
    return this.post({ event: 'FOLDER_CREATED', payload: folder, email, clientId });
  }

  folderUpdated({
    folder,
    email,
    clientId,
  }: { folder: FolderAttributes } & Pick<RequestData, 'email' | 'clientId'>): Promise<void> {
    return this.post({ event: 'FOLDER_UPDATED', payload: folder, email, clientId });
  }

  folderDeleted({ id, email, clientId }: { id: number } & Pick<RequestData, 'email' | 'clientId'>): Promise<void> {
    return this.post({ event: 'FOLDER_DELETED', payload: { id }, email, clientId });
  }

  userStorageUpdated(
    { uuid, clientId }: { uuid: UserAttributes['uuid'] } & Pick<RequestData, 'clientId'>
  ): Promise<void> {

    return this.post({ event: 'USER_STORAGE_UPDATED', payload: {}, userId: uuid, email: '', clientId });
  }
  
  private async post(data: RequestData): Promise<void> {
    try {
      const res = await axios.post(process.env.NOTIFICATIONS_URL as string, data, {
        headers: { 'X-API-KEY': process.env.NOTIFICATIONS_API_KEY as string },
      });
      if (res.status !== 201)
        Logger.getInstance().warn(
          `Post to notifications service failed with status ${res.status}. Data: ${JSON.stringify(data, null, 2)}`,
        );
    } catch (err) {
      Logger.getInstance().warn(
        `Post to notifications service failed with error ${(err as Error).message}. Data: ${JSON.stringify(
          data,
          null,
          2,
        )}`,
      );
    }
  }
}
