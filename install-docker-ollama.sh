#!/bin/bash

echo "🐳 Installing Docker and Ollama..."
echo ""
echo "This script will:"
echo "1. Install Docker Engine"
echo "2. Add your user to the docker group"
echo "3. Start Docker service"
echo "4. Run Ollama in Docker"
echo "5. Pull the llama3.2:1b model"
echo ""
read -p "Press Enter to continue or Ctrl+C to cancel..."

# Install Docker
echo ""
echo "📦 Installing Docker Engine..."
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh

# Add user to docker group
echo ""
echo "👤 Adding $USER to docker group..."
sudo usermod -aG docker $USER

# Start Docker service
echo ""
echo "🚀 Starting Docker service..."
sudo systemctl start docker
sudo systemctl enable docker

# Wait for Docker to be ready
echo ""
echo "⏳ Waiting for Docker to be ready..."
sleep 3

# Check if we need newgrp (group might not be active yet in current session)
echo ""
echo "🐋 Running Ollama container..."
sudo docker run -d -v ollama:/root/.ollama -p 11434:11434 --name ollama ollama/ollama

# Wait for Ollama to start
echo ""
echo "⏳ Waiting for Ollama to start..."
sleep 5

# Pull the model
echo ""
echo "📥 Pulling llama3.2:1b model (this may take a few minutes)..."
sudo docker exec -it ollama ollama pull llama3.2:1b

echo ""
echo "✅ Installation complete!"
echo ""
echo "⚠️  Important: You need to log out and log back in for docker group changes to take effect."
echo "   After logging back in, you can use docker without sudo."
echo ""
echo "🧪 To run the LLM tests:"
echo "   cd /home/rafdam/projects/mcp-compression-proxy"
echo "   npm run test:e2e:real-llm"
echo ""
echo "🛑 To stop Ollama:"
echo "   docker stop ollama"
echo ""
echo "🔄 To start Ollama again:"
echo "   docker start ollama"
