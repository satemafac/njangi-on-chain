# Start zkLogin Services

Start the Docker-based zkLogin prover services for development.

## Task

1. Check if Docker is running
2. Start zkLogin services using `docker-compose up -d`
3. Verify services are running on ports 5001 and 5003
4. Confirm zkLogin API endpoints are accessible
5. Check service logs for any errors

## Success Criteria

- Docker containers start successfully
- Prover service responds on port 5001
- Salt service responds on port 5003
- No connection errors in logs
- Ready to handle zkLogin authentication flows

## Alternative

If Docker is not available or preferred, run:
```bash
./start-zklogin-services.sh
```

## Notes

- zkLogin enables social OAuth (Google/Facebook/Apple) authentication
- Session state persists across OAuth flows
- Address generation is deterministic based on social identity
- Check src/services/enokiZkLoginService.ts for integration
- Services required for /api/zkLogin endpoint to function
