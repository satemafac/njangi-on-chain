#!/bin/bash

# Install git-lfs if not present
if ! command -v git-lfs &> /dev/null; then
  echo "Git LFS not found, installing..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    brew install git-lfs
  else
    curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.deb.sh | sudo bash
    sudo apt-get install git-lfs
  fi
  git lfs install
fi

echo "Downloading main zkey file for zkLogin (for Testnet/Mainnet)..."

# Store original directory
ORIGINAL_DIR=$(pwd)

# Create a temporary directory
TEMP_DIR=$(mktemp -d)
cd $TEMP_DIR

# Clone the repository without checking out the LFS objects yet
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/sui-foundation/zklogin-ceremony-contributions.git

# Enter the repository
cd zklogin-ceremony-contributions

# Only pull the specific zkey file we need
git lfs pull --include "zkLogin-main.zkey"

# Copy the file to the original directory and name it zkLogin.zkey
cp zkLogin-main.zkey "$ORIGINAL_DIR/zkLogin.zkey"

# Go back to the original directory
cd "$ORIGINAL_DIR"

# Clean up
rm -rf $TEMP_DIR

echo "Download complete. zkLogin.zkey is now available in the current directory." 