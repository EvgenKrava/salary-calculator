function required(name: string): string {
  const value = import.meta.env[name as keyof ImportMetaEnv] as string | undefined;
  if (!value) {
    // Fail at startup with the fix, rather than a confusing 401 later.
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it from the infra stack's Terraform outputs.`,
    );
  }
  return value;
}

export const config = {
  apiUrl: required('VITE_API_URL'),
  userPoolId: required('VITE_COGNITO_USER_POOL_ID'),
  clientId: required('VITE_COGNITO_CLIENT_ID'),
};
