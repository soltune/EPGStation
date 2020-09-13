import { inject, injectable } from 'inversify';
import * as path from 'path';
import * as apid from '../../../../api';
import DropLogFile from '../../../db/entities/DropLogFile';
import Thumbnail from '../../../db/entities/Thumbnail';
import VideoFile from '../../../db/entities/VideoFile';
import FileUtil from '../../../util/FileUtil';
import IVideoUtil from '../../api/video/IVideoUtil';
import IDropLogFileDB from '../../db/IDropLogFileDB';
import IRecordedDB from '../../db/IRecordedDB';
import IRecordedHistoryDB from '../../db/IRecordedHistoryDB';
import IThumbnailDB from '../../db/IThumbnailDB';
import IVideoFileDB from '../../db/IVideoFileDB';
import IRecordedEvent from '../../event/IRecordedEvent';
import IConfigFile from '../../IConfigFile';
import IConfiguration from '../../IConfiguration';
import ILogger from '../../ILogger';
import ILoggerModel from '../../ILoggerModel';
import IRecordingManageModel from '../recording/IRecordingManageModel';
import IRecordedManageModel, { AddVideoFileOption } from './IRecordedManageModel';

@injectable()
export default class RecordedManageModel implements IRecordedManageModel {
    private log: ILogger;
    private config: IConfigFile;
    private recordedDB: IRecordedDB;
    private videoFileDB: IVideoFileDB;
    private thumbnailDB: IThumbnailDB;
    private dropLogFileDB: IDropLogFileDB;
    private recordedHistoryDB: IRecordedHistoryDB;
    private recordingManageModel: IRecordingManageModel;
    private recordedEvent: IRecordedEvent;
    private videoUtil: IVideoUtil;

    constructor(
        @inject('ILoggerModel') logger: ILoggerModel,
        @inject('IConfiguration') configuration: IConfiguration,
        @inject('IRecordedDB') recordedDB: IRecordedDB,
        @inject('IVideoFileDB') videoFileDB: IVideoFileDB,
        @inject('IThumbnailDB') thumbnailDB: IThumbnailDB,
        @inject('IDropLogFileDB') dropLogFileDB: IDropLogFileDB,
        @inject('IRecordedHistoryDB') recordedHistoryDB: IRecordedHistoryDB,
        @inject('IRecordingManageModel')
        recordingManageModel: IRecordingManageModel,
        @inject('IRecordedEvent') recordedEvent: IRecordedEvent,
        @inject('IVideoUtil') videoUtil: IVideoUtil,
    ) {
        this.log = logger.getLogger();
        this.config = configuration.getConfig();
        this.recordedDB = recordedDB;
        this.videoFileDB = videoFileDB;
        this.thumbnailDB = thumbnailDB;
        this.dropLogFileDB = dropLogFileDB;
        this.recordedHistoryDB = recordedHistoryDB;
        this.recordingManageModel = recordingManageModel;
        this.recordedEvent = recordedEvent;
        this.videoUtil = videoUtil;
    }

    /**
     * 指定した録画情報と各種ファイルを削除する
     * @param recordedId: RecordedId
     * @return Promise<void>
     */
    public async delete(recordedId: apid.RecordedId): Promise<void> {
        this.log.system.info(`delete recorded: ${recordedId}`);
        const recorded = await this.recordedDB.findId(recordedId);
        if (recorded === null) {
            this.log.system.warn(`${recordedId} is null`);
            throw new Error('RecordedIdIsNotFound');
        }

        // 録画中なら停止
        if (
            recorded.isRecording === true &&
            recorded.reserveId !== null &&
            this.recordingManageModel.hasReserve(recorded.reserveId) === true
        ) {
            await this.recordingManageModel.cancel(recorded.reserveId, true);
        }

        const hasThumbnails = typeof recorded.thumbnails !== 'undefined' && recorded.thumbnails.length > 0;
        const hasVideoFiles = typeof recorded.videoFiles !== 'undefined' && recorded.videoFiles.length > 0;

        // サムネイル実ファイル削除
        if (hasThumbnails === true) {
            for (const t of recorded.thumbnails!) {
                const filePath = this.getThumbnailPath(t);
                this.log.system.info(`delete: ${filePath}`);
                await FileUtil.unlink(filePath).catch(err => {
                    this.log.system.error(`failed to delete ${filePath}`);
                    this.log.system.error(err);
                });
            }
        }

        // 録画ファイル実ファイル削除
        if (hasVideoFiles === true) {
            for (const v of recorded.videoFiles!) {
                let filePath: string | null;
                try {
                    filePath = await this.videoUtil.getFullFilePathFromId(v.id);
                    if (filePath === null) {
                        throw new Error('GetVideoFilePathError');
                    }
                } catch (err) {
                    this.log.system.error(`get video file path error: ${v.id}`);
                    this.log.system.error(err);
                    this.log.system.error(v);
                    continue;
                }

                this.log.system.info(`delete: ${filePath}`);
                await FileUtil.unlink(filePath).catch(err => {
                    this.log.system.error(`failed to delete ${filePath}`);
                    this.log.system.error(err);
                });
            }
        }

        // ドロップログファイル削除処理
        if (typeof recorded.dropLogFile !== 'undefined' && recorded.dropLogFile !== null) {
            const filePath = this.getDropLogFilePath(recorded.dropLogFile);
            this.log.system.info(`delete: ${filePath}`);
            await FileUtil.unlink(filePath).catch(err => {
                this.log.system.error(`failed to delete ${filePath}`);
                this.log.system.error(err);
            });
        }

        // DB からサムネイル情報削除
        if (hasThumbnails === true) {
            this.thumbnailDB.deleteRecordedId(recordedId).catch(err => {
                this.log.system.error(`falied to delete thumbnail data: ${recordedId}`);
                this.log.system.error(err);
            });
        }

        // DB から録画ファイル情報削除
        if (hasVideoFiles === true) {
            await this.videoFileDB.deleteRecordedId(recordedId).catch(err => {
                this.log.system.error(`falied to delete video data: ${recordedId}`);
                this.log.system.error(err);
            });
        }

        // DB から録画情報削除
        await this.recordedDB.deleteOnce(recordedId).catch(err => {
            this.log.system.error(`falied to delete recorded data: ${recordedId}`);
            this.log.system.error(err);
        });

        // DB からドロップログファイル情報削除
        if (typeof recorded.dropLogFile !== 'undefined' && recorded.dropLogFile !== null) {
            await this.dropLogFileDB.deleteOnce(recorded.dropLogFile.id).catch(err => {
                this.log.system.error(`failed to delete drop log data: ${recorded.dropLogFile?.id}`);
                this.log.system.error(err);
            });
        }

        this.log.system.info(`successful delete recorded: ${recordedId}`);

        // イベント発行
        this.recordedEvent.emitDeleteRecorded(recorded);
    }

    /**
     * サムネイルファイルパス取得
     * @param thumbnail: Thumbnail
     * @return string
     */
    private getThumbnailPath(thumbnail: Thumbnail): string {
        return path.join(this.config.thumbnail, thumbnail.filePath);
    }

    /**
     * ドロップログファイルパス取得
     * @param dropLogFile: DropLogFile
     * @return string
     */
    private getDropLogFilePath(dropLogFile: DropLogFile): string {
        return path.join(this.config.dropLog, dropLogFile.filePath);
    }

    /**
     * 指定されて video file id のファイルサイズを更新する
     * @param videoFileId: apid.VideoFileId
     * @return Promise<void>;
     */
    public async updateVideoFileSize(videoFileId: apid.VideoFileId): Promise<void> {
        this.log.system.info(`update video file size: ${videoFileId}`);

        const filePath = await this.videoUtil.getFullFilePathFromId(videoFileId);
        if (filePath === null) {
            this.log.system.error(`video file is not found: ${videoFileId}`);
            throw new Error('VideoFileIsNotFound');
        }

        const fileSize = await FileUtil.getFileSize(filePath);

        await this.videoFileDB.updateSize(videoFileId, fileSize);

        this.recordedEvent.emitUpdateVideoFileSize(videoFileId);
    }

    /**
     * option で指定されたビデオファイルを追加する
     * @param option: AddVideoFileOption
     * @return Promise<apid.VideoFileId>
     */
    public async addVideoFile(option: AddVideoFileOption): Promise<apid.VideoFileId> {
        this.log.system.info(`add video file: ${option.recordedId} ${option.filePath}`);

        const parentDirPath = this.videoUtil.getParentDirPath(option.parentDirectoryName);
        if (parentDirPath === null) {
            this.log.system.error(`parent directory is null: ${option.parentDirectoryName}`);
            throw new Error('ParentDirectoryIsNull');
        }

        const fileSize = await FileUtil.getFileSize(path.join(parentDirPath, option.filePath));

        const videoFile = new VideoFile();
        videoFile.parentDirectoryName = option.parentDirectoryName;
        videoFile.filePath = option.filePath;
        videoFile.type = option.type;
        videoFile.name = option.name;
        videoFile.size = fileSize;
        videoFile.recordedId = option.recordedId;

        const newVideoFileId = await this.videoFileDB.insertOnce(videoFile).catch(err => {
            this.log.system.error(`failed to add video: ${option.parentDirectoryName}/${option.filePath}`);
            this.log.system.error(err);
            throw err;
        });

        this.recordedEvent.emitAddVideoFile(newVideoFileId);

        return newVideoFileId;
    }

    /**
     * 指定された video file id のファイルを削除する
     * @param videoFileid: apid.VideoFileId
     * @return Promise<void>
     */
    public async deleteVideoFile(videoFileid: apid.VideoFileId): Promise<void> {
        this.log.system.info(`delete video file: ${videoFileid}`);

        const video = await this.videoFileDB.findId(videoFileid);
        if (video === null) {
            this.log.system.info(`video file is not found: ${videoFileid}`);
            throw new Error('VideoFileIsNotFound');
        }

        // 実ファイル削除
        const filePath = await this.videoUtil.getFullFilePathFromId(videoFileid);
        if (filePath !== null) {
            this.log.system.info(`delete: ${filePath}`);
            await FileUtil.unlink(filePath).catch(err => {
                this.log.system.error(`failed to delete ${filePath}`);
                this.log.system.error(err);
            });
        }

        // DB から削除
        await this.videoFileDB.deleteOnce(videoFileid);

        // video に紐付けられていた recorded が空かチェック
        const recorded = await this.recordedDB.findId(video.recordedId);
        if (recorded !== null && typeof recorded.videoFiles !== 'undefined' && recorded.videoFiles.length === 0) {
            // 空だったので recorded も削除
            this.log.system.info(`empty video files: ${video.recordedId}`);
            await this.delete(video.recordedId);
        } else {
            this.recordedEvent.emitDeleteVideoFile(videoFileid);
        }
    }

    /**
     * 保護状態を変更する
     * @param recordedId: apid.RecordedId
     * @param isProtect: boolean
     * @return Promise<void>
     */
    public async changeProtect(recordedId: apid.RecordedId, isProtect: boolean): Promise<void> {
        this.log.system.info((isProtect === true ? 'set protect' : 'remove protect') + `: ${recordedId}`);

        await this.recordedDB.changeProtect(recordedId, isProtect);
        this.recordedEvent.emitChangeProtect(recordedId, isProtect);
    }

    /**
     * RecordedHistory の保存期間外のデータを削除する
     * @return Promise<void>
     */
    public async historyCleanup(): Promise<void> {
        const date = new Date().getTime() - this.config.recordedHistoryRetentionPeriodDays * 24 * 60 * 60 * 1000;
        await this.recordedHistoryDB.delete(date).catch(err => {
            this.log.system.error('failed to historyCleanup');
            this.log.system.error(err);
        });
    }

    /**
     * DB に登録されていない recorded 下のファイル削除 &  DB に登録されているが存在しない番組情報の削除
     * @return Promise<void>
     */
    public async videoFileCleanup(): Promise<void> {
        this.log.system.info('start video files cleanup');

        const videoFiles = await this.videoFileDB.findAll();

        // ファイル, ディレクトリ索引生成と DB 上に存在するが実ファイルが存在しないデータを削除する
        const fileIndex: { [filePath: string]: boolean } = {}; // ファイル索引
        const dirIndex: { [dirPath: string]: boolean } = {}; // ディレクトリ索引
        for (const video of videoFiles) {
            const videoFilePath = this.videoUtil.getFullFilePathFromVideoFile(video);
            if (videoFilePath === null) {
                continue;
            }

            if ((await this.checkFileExistence(videoFilePath)) === true) {
                // ファイルが存在するなら索引に追加
                fileIndex[videoFilePath] = true;
                const parentDir = path.dirname(videoFilePath).replace(new RegExp(`\\${path.sep}$`), '');
                dirIndex[parentDir] = true;
            } else {
                // ファイルが存在しないなら削除
                await this.deleteVideoFile(video.id).catch(() => {});
            }
        }

        // 実ファイルリストを取得する
        const list: FileUtil.FileList = {
            files: [],
            directories: [],
        };
        for (const r of this.config.recorded) {
            const l = await FileUtil.getFileList(r.path);
            Array.prototype.push.apply(list.files, l.files);
            Array.prototype.push.apply(list.directories, l.directories);
            dirIndex[r.path] = true; // 親ディレクトリを索引に追加
        }
        // ディレクトリ削除時にネストが深いディレクトリから削除するためにソート
        list.directories.sort((dir1, dir2) => {
            return dir2.length - dir1.length;
        });

        // ファイル索引上に存在しないファイルを削除する
        for (const file of list.files) {
            if (typeof fileIndex[file] !== 'undefined') {
                continue;
            }

            this.log.system.info(`delete file: ${file}`);
            await FileUtil.unlink(file).catch(err => {
                this.log.system.error(`failed to delete file: ${file}`);
                this.log.system.error(err);
            });
        }

        // ディレクトリ索引上に存在しないディレクトリを削除する
        for (const dir of list.directories) {
            if (typeof dirIndex[dir] !== 'undefined') {
                continue;
            }

            this.log.system.info(`delete directory: ${dir}`);
            try {
                // ディレクトリが空かチェック
                if ((await FileUtil.isEmptyDirectory(dir)) === true) {
                    await FileUtil.rmdir(dir);
                } else {
                    this.log.system.warn(`directory is not empty: ${dir}`);
                }
            } catch (err) {
                this.log.system.error(`failed to delete directory: ${dir}`);
                this.log.system.error(err);
            }
        }

        this.log.system.info('start video files cleanup completed');
    }

    /**
     * DB に登録されていないログファイル削除 &  DB に登録されているが存在しないログ情報の削除
     */
    public async dropLogFileCleanup(): Promise<void> {
        this.log.system.info('start drop log files cleanup');
        const dropLogs = await this.dropLogFileDB.findAll();

        // ファイル, ディレクトリ索引生成と DB 上に存在するが実ファイルが存在しないデータを削除する
        const fileIndex: { [filePath: string]: boolean } = {}; // ファイル索引
        for (const dropLog of dropLogs) {
            const filePath = this.getDropLogFilePath(dropLog);

            if ((await this.checkFileExistence(filePath)) === true) {
                // ファイルが存在するなら索引に追加
                fileIndex[filePath] = true;
            } else {
                this.log.system.warn(`drop file is not exist: ${filePath}`);
                // ファイルが存在しないなら削除
                try {
                    await this.recordedDB.removeDropLogFileId(dropLog.id);
                    await this.dropLogFileDB.deleteOnce(dropLog.id);
                } catch (err) {
                    this.log.system.error(err);
                }
            }
        }

        // ファイル索引上に存在しないファイルを削除する
        const list = await FileUtil.getFileList(this.config.dropLog);
        for (const file of list.files) {
            if (typeof fileIndex[file] !== 'undefined') {
                continue;
            }

            this.log.system.info(`delete drop log file: ${file}`);
            await FileUtil.unlink(file).catch(err => {
                this.log.system.error(`failed to drop log file: ${file}`);
                this.log.system.error(err);
            });
        }

        this.log.system.info('start drop log files cleanup completed');
    }

    /**
     * 指定したファイルパスにファイルが存在するか
     * @param filePath: string ファイルパス
     * @return Promise<boolean> ファイルが存在するなら true を返す
     */
    private async checkFileExistence(filePath: string): Promise<boolean> {
        try {
            await FileUtil.stat(filePath);

            return true;
        } catch (err) {
            return false;
        }
    }
}
