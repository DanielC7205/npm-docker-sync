# Build frontend (outputs to /wwwroot via vite outDir)
FROM node:22-alpine AS ui-build
WORKDIR /src
COPY ui/package.json ui/package-lock.json* ./ui/
WORKDIR /src/ui
RUN npm install
COPY ui/ ./
RUN npm run build

# Build .NET
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY ["NpmDockerSync.csproj", "./"]
RUN dotnet restore "NpmDockerSync.csproj"
COPY . .
COPY --from=ui-build /src/wwwroot ./wwwroot
RUN dotnet build "NpmDockerSync.csproj" -c Release -o /app/build
RUN dotnet publish "NpmDockerSync.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Final runtime
FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
RUN mkdir -p /data
COPY --from=build /app/publish .
ENV ASPNETCORE_URLS=http://0.0.0.0:8080
ENV SQLITE_PATH=/data/npm-docker-sync.db
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["dotnet", "NpmDockerSync.dll"]
