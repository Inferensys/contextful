# Resource Access

The resource access flow starts in `AuthService.login`, loads the user profile, then returns dashboard and billing resources.

## Troubleshooting

If resources are missing, inspect the profile loader and the auth service import path.
