export type ClientBotListRequest = {
  type: "client.bot.list.request";
  requestId: string;
  deviceId: string;
  hostId: string;
};

export type ClientSessionSnapshotRequest = {
  type: "client.session.snapshot.request";
  requestId: string;
  deviceId: string;
  hostId: string;
  accountId: string;
};

export type ClientHostRequest =
  | ClientBotListRequest
  | ClientSessionSnapshotRequest;

type HostRequestSink = (request: ClientHostRequest) => void;

export type HostAwareRouter = {
  attachHost(hostId: string, sink: HostRequestSink): () => void;
  routeBotListRequest(request: ClientBotListRequest): boolean;
  routeSessionSnapshotRequest(request: ClientSessionSnapshotRequest): boolean;
};

export const createHostAwareRouter = (): HostAwareRouter => {
  const hostSinks = new Map<string, HostRequestSink>();

  return {
    attachHost(hostId, sink) {
      hostSinks.set(hostId, sink);
      return () => {
        const currentSink = hostSinks.get(hostId);
        if (currentSink === sink) {
          hostSinks.delete(hostId);
        }
      };
    },

    routeBotListRequest(request) {
      const sink = hostSinks.get(request.hostId);
      if (!sink) {
        return false;
      }
      sink(request);
      return true;
    },

    routeSessionSnapshotRequest(request) {
      const sink = hostSinks.get(request.hostId);
      if (!sink) {
        return false;
      }
      sink(request);
      return true;
    },
  };
};
