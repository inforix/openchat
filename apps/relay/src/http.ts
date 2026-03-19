import type {
  AuthBootstrapInput,
  AuthBootstrapResult,
  RelayAuth,
} from "./auth";

export type RelayHttpService = {
  bootstrapAuth(input: AuthBootstrapInput): AuthBootstrapResult;
};

export const createRelayHttpService = (input: {
  auth: RelayAuth;
}): RelayHttpService => ({
  bootstrapAuth(payload) {
    return input.auth.bootstrap(payload);
  },
});
