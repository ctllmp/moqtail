/**
 * Copyright 2026 The MOQtail Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useEffect, useMemo, useState, useRef, useCallback } from 'preact/hooks';
import { Player } from '@/lib/player';
import { Tuple, type CMSFTrack } from 'moqtail';
import MSEBuffer from '@/lib/buffer';
import type { Track, Status } from '@/types';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { VideoPlayer } from '@/components/VideoPlayer';
import { logger } from '@/lib/logger';
import {
  AbrController,
  ThroughputAbr,
  BolaMoQ,
  McTsAbr,
  defaultConfig as defaultAbrConfig,
  logManifest,
  logDecision,
  type Abr,
  type AbrDecision,
  type TrackCandidate,
} from '@/lib/abr';

type AbrAlgo = 'pf' | 'th' | 'bola' | 'mcts';

logger.setDefaultLevel('debug');

function readAbrAlgo(): AbrAlgo | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  if (!params.has('abr')) return null;
  const v = params.get('abr');
  // MCTS-MoQ is the current default for `?abr` / `?abr=on` / `?abr=1`.
  // PF-ABR is kept as an opt-in comparison artifact (`?abr=pf`).
  if (v === '' || v === 'on' || v === '1' || v === 'mcts' || v === null) return 'mcts';
  if (v === 'pf') return 'pf';
  if (v === 'th' || v === 'throughput') return 'th';
  if (v === 'bola') return 'bola';
  return 'mcts';
}

function readMonitorFlag(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('monitor') === '1';
}

/**
 * Hypothetical bitrate ladder used in monitor mode when the real catalog lacks
 * per-track bitrate metadata or only has one track. PF-ABR then runs against
 * this ladder while the player keeps playing the actual single track.
 */
const MONITOR_LADDER: TrackCandidate[] = [
  { name: 'mon-t300', bitrateBps: 300_000, width: 426, height: 240 },
  { name: 'mon-t750', bitrateBps: 750_000, width: 640, height: 360 },
  { name: 'mon-t1850', bitrateBps: 1_850_000, width: 1280, height: 720 },
  { name: 'mon-t4300', bitrateBps: 4_300_000, width: 1920, height: 1080 },
  { name: 'mon-t8000', bitrateBps: 8_000_000, width: 2560, height: 1440 },
];

function toCandidate(t: CMSFTrack): TrackCandidate {
  return {
    name: t.name,
    bitrateBps: t.bitrate ?? 0,
    width: t.width,
    height: t.height,
  };
}

function sortTracks(tracks: CMSFTrack[]) {
  return tracks.sort((a, b) => {
    // sort by bitrate (desc), then resolution (desc), then name (asc)
    const bitrateA = a.bitrate || 0;
    const bitrateB = b.bitrate || 0;
    if (bitrateA !== bitrateB) return bitrateB - bitrateA;

    const resA = (a.width || 0) * (a.height || 0);
    const resB = (b.width || 0) * (b.height || 0);
    if (resA !== resB) return resB - resA;

    return a.name.localeCompare(b.name);
  });
}

export function App() {
  const [relayUrl, setRelayUrl] = useState('https://relay.moqtail.dev');
  const [namespace, setNamespace] = useState('moqtail/testsrc');
  const [status, setStatus] = useState<Status>('idle');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<string | null>(null);
  const [selectedAudio, setSelectedAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const playerRef = useRef<Player | null>(null);
  const bufferRef = useRef<MSEBuffer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const abrControllerRef = useRef<Abr | null>(null);
  const startPlaybackRef = useRef<(video: string | null, audio: string | null) => void>(() => {});
  const abrAlgo = useMemo(readAbrAlgo, []);
  const abrEnabled = abrAlgo !== null;
  const monitorMode = useMemo(readMonitorFlag, []);
  const [abrHistory, setAbrHistory] = useState<AbrDecision[]>([]);
  const [monitorActive, setMonitorActive] = useState(false);
  const abrLastDecision = abrHistory.length === 0 ? null : abrHistory[abrHistory.length - 1];

  const disposePlayer = useCallback(async () => {
    if (abrControllerRef.current) {
      try {
        abrControllerRef.current.dispose();
      } catch {}
      abrControllerRef.current = null;
      setAbrHistory([]);
      setMonitorActive(false);
    }
    if (playerRef.current) {
      try {
        await playerRef.current.dispose();
      } catch {}
      playerRef.current = null;
    }
    if (bufferRef.current) {
      try {
        bufferRef.current.dispose();
      } catch {}
      bufferRef.current = null;
    }
  }, []);

  const attachAbr = useCallback(
    (player: Player, allTracks: Track[], activeVideo: string, audio: string | null) => {
      if (!abrEnabled) return;
      const videoTracksRaw = allTracks.filter(t => t.role === 'video');
      // warn-level so this one-shot diagnostic survives the default 'warn' log filter.
      logger.warn(
        'abr',
        `catalog video tracks: ${JSON.stringify(
          videoTracksRaw.map(t => ({
            name: t.name,
            bitrate: t.bitrate ?? null,
            width: t.width ?? null,
            height: t.height ?? null,
            codec: t.codec ?? null,
          })),
        )}`,
      );
      const realCandidates = videoTracksRaw.filter(t => (t.bitrate ?? 0) > 0).map(toCandidate);
      const realActiveOk = realCandidates.some(c => c.name === activeVideo);
      const canRunReal = realCandidates.length >= 2 && realActiveOk;

      let candidates: TrackCandidate[];
      let initialTrack: string;
      let useMonitor = false;
      if (canRunReal) {
        candidates = realCandidates;
        initialTrack = activeVideo;
      } else if (monitorMode) {
        // Real catalog can't support ABR. Run against a synthetic ladder and
        // remap incoming track callbacks to the controller's hypothetical track
        // so the filter still updates from live throughput.
        candidates = MONITOR_LADDER;
        initialTrack = MONITOR_LADDER[0].name;
        useMonitor = true;
        const why = realCandidates.length === 0
          ? 'no bitrate metadata'
          : realCandidates.length === 1
            ? 'only one candidate'
            : 'active track not in candidate set';
        logger.warn(
          'abr',
          `monitor mode: real catalog unusable (${why}); running PF-ABR against synthetic ladder`,
        );
      } else {
        if (realCandidates.length === 0) {
          logger.warn(
            'abr',
            'no video candidates with bitrate metadata — ABR disabled this session (pass ?monitor=1 to run against a synthetic ladder)',
          );
        } else if (realCandidates.length === 1) {
          logger.warn(
            'abr',
            `only one video candidate (${realCandidates[0].name}) — ABR disabled (nothing to switch to; pass ?monitor=1 to demo against a synthetic ladder)`,
          );
        } else {
          logger.warn(
            'abr',
            `active track "${activeVideo}" has no bitrate metadata — ABR disabled (pass ?monitor=1 to demo against a synthetic ladder)`,
          );
        }
        return;
      }

      const sharedOpts = {
        config: defaultAbrConfig,
        candidates,
        initialTrack,
        getBufferedSeconds: () => player.getBufferedSeconds(),
        switchTrack: (next: string) => {
          if (useMonitor) {
            // Cannot actually switch — the real catalog has one track. Log the
            // hypothetical choice so it still shows up in the timeline.
            logger.warn('abr', `monitor mode: hypothetical switch -> ${next} (no resubscribe)`);
            return;
          }
          startPlaybackRef.current(next, audio);
        },
        onDecision: (d: AbrDecision) => {
          logDecision(d);
          // Keep a bounded rolling window so the panel never grows unbounded.
          setAbrHistory(prev => {
            const next = prev.length >= 240 ? prev.slice(prev.length - 239) : prev.slice();
            next.push(d);
            return next;
          });
        },
      };
      const ctrl: Abr =
        abrAlgo === 'th'
          ? new ThroughputAbr(sharedOpts)
          : abrAlgo === 'bola'
            ? new BolaMoQ(sharedOpts)
            : abrAlgo === 'mcts'
              ? new McTsAbr(sharedOpts)
              : new AbrController(sharedOpts);
      abrControllerRef.current = ctrl;
      setMonitorActive(useMonitor);
      if (useMonitor) {
        // Remap every real-track callback to the controller's current hypothetical
        // track so the filter ingests live throughput as if the synthetic track
        // were really being delivered.
        player.onObjectMeasured = m => {
          ctrl.onObjectMeasured({ ...m, trackName: ctrl.getCurrentTrack().name });
        };
        player.onEndOfGroup = (_t, g) => {
          ctrl.onEndOfGroup(ctrl.getCurrentTrack().name, g);
        };
      } else {
        player.onObjectMeasured = m => ctrl.onObjectMeasured(m);
        player.onEndOfGroup = (t, g) => ctrl.onEndOfGroup(t, g);
      }
      logManifest({
        configuredAtMs: Date.now(),
        config: defaultAbrConfig,
        candidates,
        initialTrack,
      });
    },
    [abrEnabled, abrAlgo, monitorMode],
  );

  const initializePlaybackSession = useCallback(async () => {
    if (!videoRef.current) return null;

    logger.info('app', `initializePlaybackSession: relay="${relayUrl}" ns="${namespace}"`);
    const player = new Player({
      relayUrl,
      namespace: Tuple.fromUtf8Path(namespace),
      receiveCatalogViaSubscribe: true,
    });
    playerRef.current = player;

    const catalog = await player.initialize();
    const allTracks = sortTracks(catalog.getTracks());
    logger.info(
      'app',
      `initializePlaybackSession: ${allTracks.length} track(s): ${allTracks.map(t => `${t.name}(${t.role})`).join(', ')}`,
    );
    setTracks(allTracks);

    await player.attachMedia(videoRef.current);
    bufferRef.current = new MSEBuffer(videoRef.current);
    logger.info('app', 'initializePlaybackSession: media attached, MSEBuffer created');

    return { player, allTracks };
  }, [relayUrl, namespace]);

  const handleConnect = useCallback(async () => {
    if (!videoRef.current) return;
    setStatus('connecting');
    setError(null);
    setTracks([]);
    setSelectedVideo(null);
    setSelectedAudio(null);

    await disposePlayer();

    try {
      const session = await initializePlaybackSession();
      if (!session) return;

      const { player, allTracks } = session;

      const firstVideo = allTracks.find(t => t.role === 'video');
      logger.info('app', `handleConnect: firstVideo="${firstVideo?.name ?? 'none'}"`);
      if (firstVideo) {
        setSelectedVideo(firstVideo.name);
        setStatus('restarting');
        await player.addMediaTrack(firstVideo.name);
        logger.info('app', 'handleConnect: addMediaTrack done, calling startMedia');
        await player.startMedia();
        attachAbr(player, allTracks, firstVideo.name, null);
        logger.info('app', 'handleConnect: startMedia done — status=playing');
        setStatus('playing');
      } else {
        logger.warn('app', 'handleConnect: no video track found in catalog');
        setStatus('ready');
      }
    } catch (err) {
      logger.error('app', `handleConnect: error — ${(err as Error).message}`);
      setError((err as Error).message);
      setStatus('error');
      await disposePlayer();
    }
  }, [attachAbr, disposePlayer, initializePlaybackSession]);

  const startPlayback = useCallback(
    async (videoTrack: string | null, audioTrack: string | null) => {
      if (!videoRef.current) return;
      if (!videoTrack && !audioTrack) {
        await disposePlayer();
        setStatus('ready');
        return;
      }

      logger.info(
        'app',
        `startPlayback: video="${videoTrack ?? 'none'}" audio="${audioTrack ?? 'none'}"`,
      );
      setStatus('restarting');
      await disposePlayer();

      try {
        const session = await initializePlaybackSession();
        if (!session) return;

        const { player, allTracks } = session;

        if (videoTrack) await player.addMediaTrack(videoTrack);
        if (audioTrack) await player.addMediaTrack(audioTrack);

        logger.info('app', 'startPlayback: calling startMedia');
        await player.startMedia();
        if (videoTrack) attachAbr(player, allTracks, videoTrack, audioTrack);
        logger.info('app', 'startPlayback: startMedia done — status=playing');
        setStatus('playing');
      } catch (err) {
        logger.error('app', `startPlayback: error — ${(err as Error).message}`);
        setError((err as Error).message);
        setStatus('error');
        await disposePlayer();
      }
    },
    [attachAbr, disposePlayer, initializePlaybackSession],
  );

  useEffect(() => {
    startPlaybackRef.current = (v, a) => {
      void startPlayback(v, a);
    };
  }, [startPlayback]);

  const handleTrackChange = useCallback(
    (track: Track, checked: boolean) => {
      if (track.role !== 'video' && track.role !== 'audio') return;

      let newVideo = selectedVideo;
      let newAudio = selectedAudio;

      if (track.role === 'video') {
        // clicking the active track unchecks it; clicking any other switches to it
        newVideo = track.name === selectedVideo && !checked ? null : track.name;
      } else {
        newAudio = track.name === selectedAudio && !checked ? null : track.name;
      }

      setSelectedVideo(newVideo);
      setSelectedAudio(newAudio);
      startPlayback(newVideo, newAudio);
    },
    [selectedVideo, selectedAudio, startPlayback],
  );

  const hasTracks = tracks.length > 0;

  return (
    <div className="flex h-dvh w-dvw flex-col bg-neutral-950 font-sans text-neutral-100 antialiased">
      <Header status={status} />

      {/* Body */}
      <div className="flex h-full min-h-0 w-full flex-1 grow flex-col md:flex-row">
        <Sidebar
          relayUrl={relayUrl}
          onRelayUrlChange={setRelayUrl}
          namespace={namespace}
          onNamespaceChange={setNamespace}
          status={status}
          tracks={tracks}
          selectedVideo={selectedVideo}
          selectedAudio={selectedAudio}
          onConnect={handleConnect}
          onTrackChange={handleTrackChange}
          error={error}
          abrEnabled={abrEnabled}
          abrAlgo={abrAlgo}
          abrLastDecision={abrLastDecision}
          abrHistory={abrHistory}
          abrMonitorActive={monitorActive}
          onAbrReset={() => setAbrHistory([])}
        />
        <VideoPlayer ref={videoRef} hasTracks={hasTracks} />
      </div>
    </div>
  );
}
