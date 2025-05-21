FROM mysten/zklogin:prover-fe-stable

# Set environment variables
ENV NODE_ENV=production
ENV DEBUG=zkLogin:info,jwks
ENV PROVER_TIMEOUT=45
ENV PROVER_URI="https://zklogin-backend-fix3-46730ab9ae9f.herokuapp.com/input"

# Create start script
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Expose port
EXPOSE 8080

# Start the service
CMD ["/app/start.sh"] 