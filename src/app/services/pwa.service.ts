import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { guid } from '@datorama/akita';
import { Channel } from 'diagnostics_channel';
import { parse } from 'iptv-playlist-parser';
import { NgxIndexedDBService } from 'ngx-indexed-db';
import { catchError, combineLatest, map, switchMap, throwError } from 'rxjs';
import {
    ERROR,
    PLAYLIST_GET_ALL,
    PLAYLIST_GET_ALL_RESPONSE,
    PLAYLIST_GET_BY_ID,
    PLAYLIST_PARSE,
    PLAYLIST_PARSE_BY_URL,
    PLAYLIST_PARSE_RESPONSE,
    PLAYLIST_REMOVE_BY_ID,
    PLAYLIST_REMOVE_BY_ID_RESPONSE,
    PLAYLIST_SAVE_DETAILS,
    PLAYLIST_UPDATE,
    PLAYLIST_UPDATE_FAVORITES,
    PLAYLIST_UPDATE_POSITIONS,
} from '../../../shared/ipc-commands';
import {
    Playlist,
    PlaylistUpdateState,
} from '../../../shared/playlist.interface';
import { AppConfig } from '../../environments/environment';
import { ParsedPlaylist } from '../../typings';
import { DbStores } from '../indexed-db.config';
import { DataService } from './data.service';

/**
 * Id of the channel with favorite channels aggregated from all added playlists
 */
export const GLOBAL_FAVORITES_PLAYLIST_ID = 'GLOBAL_FAVORITES';

@Injectable({
    providedIn: 'root',
})
export class PwaService extends DataService {
    /** Proxy URL to avoid CORS issues */
    corsProxyUrl = AppConfig.production
        ? 'https://iptvnator-playlist-parser-api.vercel.app/parse?url='
        : 'http://localhost:3000/parse?url=';

    /**
     * Creates an instance of PwaService.
     * @param dbService database service
     * @param http angular http client
     */
    constructor(
        private dbService: NgxIndexedDBService,
        private http: HttpClient
    ) {
        super();
        console.log('PWA service initialized...');
    }

    /**
     * Returns the current version of the app
     */
    getAppVersion(): string {
        return AppConfig.version;
    }

    /**
     * Aggregates favorite channels as objects from all available playlists
     * @param playlists all available playlists
     * @returns favorite channels
     */
    aggregateFavoriteChannels(playlists: Playlist[]): Channel[] {
        const favorites = [];
        playlists.forEach((playlist) => {
            if (playlist.favorites?.length > 0) {
                playlist.playlist.items.forEach((channel) => {
                    if (playlist.favorites.includes(channel.id)) {
                        favorites.push(channel);
                    }
                });
            }
        });
        return favorites;
    }

    /**
     * Creates a simplified playlist object which is used for global favorites
     * @param channels channels list
     * @returns simplified playlist object
     */
    createFavoritesPlaylist(channels: Channel[]): Partial<Playlist> {
        return {
            id: GLOBAL_FAVORITES_PLAYLIST_ID,
            _id: GLOBAL_FAVORITES_PLAYLIST_ID,
            count: channels.length,
            playlist: {
                items: channels,
            },
        };
    }

    /**
     * Returns the count of favorite channels from all playlists
     */
    getGlobalFavoritesCount() {
        return this.dbService.getAll(DbStores.Playlists).pipe(
            map((playlists: Playlist[]) => {
                let count = 0;
                playlists.forEach((playlist) => {
                    if (playlist.favorites.length > 0) {
                        count = count + playlist.favorites.length;
                    }
                });
                return count;
            })
        );
    }

    /**
     * Sends a message with playlist that contains favorite channels from all available playlists
     */
    sendPlaylistWithGlobalFavorites() {
        this.dbService
            .getAll(DbStores.Playlists)
            .pipe(
                map((playlists: Playlist[]) => {
                    const favoriteChannels =
                        this.aggregateFavoriteChannels(playlists);
                    const favPlaylist =
                        this.createFavoritesPlaylist(favoriteChannels);
                    return favPlaylist;
                })
            )
            .subscribe((playlist) => {
                window.postMessage({
                    type: PLAYLIST_PARSE_RESPONSE,
                    payload: playlist,
                });
            });
    }

    /**
     * Handles incoming IPC commands
     * @param type ipc command type
     * @param payload payload
     */
    sendIpcEvent(type: string, payload?: any): void {
        if (type === PLAYLIST_PARSE) {
            const parsedPlaylist = this.parsePlaylist(payload.playlist);
            const playlistObject = this.createPlaylistObject(
                payload.title,
                parsedPlaylist,
                payload.path,
                'FILE'
            );

            // save to db
            this.dbService
                .add(DbStores.Playlists, playlistObject)
                .subscribe(() => {
                    console.log('playlist was saved to db...');
                });

            window.postMessage({
                type: PLAYLIST_PARSE_RESPONSE,
                payload: playlistObject,
            });
        } else if (type === PLAYLIST_GET_BY_ID) {
            if (payload.id === GLOBAL_FAVORITES_PLAYLIST_ID) {
                this.sendPlaylistWithGlobalFavorites();
            } else {
                this.dbService
                    .getByIndex(DbStores.Playlists, '_id', payload.id)
                    .subscribe((playlist) => {
                        window.postMessage({
                            type: PLAYLIST_PARSE_RESPONSE,
                            payload: playlist,
                        });
                    });
            }
        } else if (type === PLAYLIST_REMOVE_BY_ID) {
            this.dbService
                .delete(DbStores.Playlists, payload.id)
                .subscribe((playlist) => {
                    window.postMessage({
                        type: PLAYLIST_REMOVE_BY_ID_RESPONSE,
                        payload: playlist,
                    });
                });
        } else if (type === PLAYLIST_GET_ALL) {
            this.dbService
                .getAll(DbStores.Playlists)
                .subscribe((playlists: Playlist[]) => {
                    window.postMessage({
                        type: PLAYLIST_GET_ALL_RESPONSE,
                        payload: playlists.sort(
                            (a, b) => a.position - b.position
                        ),
                    });
                });
        } else if (type === PLAYLIST_SAVE_DETAILS) {
            this.dbService
                .getByID(DbStores.Playlists, payload._id)
                .pipe(
                    switchMap((playlist: Playlist) => {
                        return this.dbService.update(DbStores.Playlists, {
                            ...playlist,
                            title: payload.title,
                        });
                    })
                )
                .subscribe((playlists) => {
                    window.postMessage({
                        type: PLAYLIST_GET_ALL_RESPONSE,
                        payload: playlists,
                    });
                });
        } else if (type === PLAYLIST_UPDATE_FAVORITES) {
            this.dbService
                .getByID(DbStores.Playlists, payload.id)
                .pipe(
                    switchMap((playlist: Playlist) => {
                        return this.dbService.update(DbStores.Playlists, {
                            ...playlist,
                            favorites: payload.favorites,
                        });
                    })
                )
                .subscribe(() => {
                    console.log('favorites were updated...');
                });
        } else if (type === PLAYLIST_PARSE_BY_URL) {
            this.fetchFromUrl(payload);
        } else if (type === PLAYLIST_UPDATE) {
            this.http
                .get(`${this.corsProxyUrl}${payload.url}`, {
                    responseType: 'text',
                })
                .pipe(
                    catchError((error) => {
                        window.postMessage({
                            type: ERROR,
                        });
                        return throwError(() => error);
                    })
                )
                .subscribe((response: any) => {
                    const refreshedPlaylist =
                        this.convertFileStringToPlaylist(response);

                    this.dbService
                        .getByID(DbStores.Playlists, payload.id)
                        .pipe(
                            switchMap((currentPlaylist: Playlist) => {
                                return this.dbService.update(
                                    DbStores.Playlists,
                                    {
                                        ...currentPlaylist,
                                        ...refreshedPlaylist,
                                        count: refreshedPlaylist.items.length,
                                        updateDate: Date.now(),
                                        updateState:
                                            PlaylistUpdateState.UPDATED,
                                    }
                                );
                            })
                        )
                        .subscribe((playlists) => {
                            console.log('playlist was updated...');
                            window.postMessage({
                                type: PLAYLIST_GET_ALL_RESPONSE,
                                payload: playlists,
                            });
                        });
                });
        } else if (type === PLAYLIST_UPDATE_POSITIONS) {
            const requests = payload.map((playlist, index) => {
                return this.dbService
                    .getByID(DbStores.Playlists, playlist._id)
                    .pipe(
                        switchMap((playlist: Playlist) => {
                            return this.dbService.update(DbStores.Playlists, {
                                ...playlist,
                                position: index,
                            });
                        })
                    );
            });

            combineLatest(requests).subscribe(() => {
                console.log('playlist positions were updated...');
            });
        }
    }

    /**
     * Fetches playlist from the specified url
     * @param payload playlist payload
     */
    fetchFromUrl(payload: Partial<Playlist>): void {
        this.http
            .get(`${this.corsProxyUrl}${payload.url}`)
            .pipe(
                catchError((error) => {
                    window.postMessage({
                        type: ERROR,
                        message: 'something went wrong',
                        status: error.status,
                    });
                    return throwError(() => error);
                })
            )
            .subscribe((response: any) => {
                this.dbService
                    .add(DbStores.Playlists, response)
                    .subscribe(() => {
                        console.log('playlist was added...');
                    });

                window.postMessage({
                    type: PLAYLIST_PARSE_RESPONSE,
                    payload: response,
                });
            });
    }

    /**
     * Converts file string to playlist object
     * @param m3uString
     */
    convertFileStringToPlaylist(m3uString: string): ParsedPlaylist {
        return this.parsePlaylist(m3uString.split('\n'));
    }

    /**
     * Saves playlist to the localStorage
     * @param name name of the playlist
     * @param playlist playlist to save
     * @param urlOrPath absolute fs path or url of the playlist
     * @param uploadType upload type - by file or via an url
     */
    createPlaylistObject(
        name: string,
        playlist: ParsedPlaylist,
        urlOrPath?: string,
        uploadType?: 'URL' | 'FILE'
    ): Playlist {
        const id = guid();
        return {
            id,
            _id: id,
            filename: name,
            title: name,
            count: playlist.items.length,
            playlist: {
                ...playlist,
                items: playlist.items.map((item) => ({
                    id: guid(),
                    ...item,
                })),
            },
            importDate: new Date().toISOString(),
            lastUsage: new Date().toISOString(),
            favorites: [],
            autoRefresh: false,
            ...(uploadType === 'URL' ? { url: urlOrPath } : {}),
            ...(uploadType === 'FILE' ? { filePath: urlOrPath } : {}),
        };
    }

    /**
     * Parses string based array to playlist object
     * @param m3uArray m3u playlist as array with strings
     */
    parsePlaylist(m3uArray: string[]): ParsedPlaylist {
        const playlistAsString = m3uArray.join('\n');
        return parse(playlistAsString);
    }

    removeAllListeners(): void {
        // not implemented
    }

    listenOn(command: string, callback: (...args: any[]) => void): void {
        window.addEventListener('message', callback);
    }
}
