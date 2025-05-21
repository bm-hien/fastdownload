function toggleAdvancedOptions() {
    const options = document.getElementById('advancedOptions');
    const toggle = document.getElementById('optionsToggle');
    
    if (options.style.display === 'none' || options.style.display === '') {
        options.style.display = 'block';
        toggle.textContent = '▲';
    } else {
        options.style.display = 'none';
        toggle.textContent = '▼';
    }
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return 'Calculating...';
    if (seconds < 60) return Math.round(seconds) + ' giây';
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        const secs = Math.round(seconds % 60);
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
    return (seconds / 3600).toFixed(1) + ' giờ';
}

async function downloadChunk(url, start, end, onProgress) {
    try {
        const response = await fetch(url, {
            headers: {
                'Range': `bytes=${start}-${end}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        // Getting content as ArrayBuffer to track progress is complex with fetch
        // So we'll simulate progress during download
        const contentLength = parseInt(response.headers.get('Content-Length') || '0');
        const buffer = await response.arrayBuffer();
        
        // Report final progress after chunk is fully downloaded
        if (onProgress) {
            onProgress(buffer.byteLength);
        }
        
        return buffer;
    } catch (error) {
        console.error('Error downloading chunk:', error);
        throw error;
    }
}

// Improved promise pool with progress tracking
async function promisePool(promiseFuncs, poolLimit, onProgress) {
    let results = [];
    const executing = new Set();
    let completedBytes = 0;
    
    async function executePromise(promiseFunc, index) {
        const chunkPromise = promiseFunc((bytes) => {
            completedBytes += bytes;
            if (onProgress) {
                onProgress(completedBytes);
            }
        });
        
        executing.add(chunkPromise);
        
        try {
            const result = await chunkPromise;
            results[index] = result;
            
            executing.delete(chunkPromise);
            
            return result;
        } catch (error) {
            console.error(`Error in chunk ${index}:`, error);
            results[index] = null; // Set failed chunk to null
            executing.delete(chunkPromise);
            throw error;
        }
    }
    
    for (let i = 0; i < promiseFuncs.length; i++) {
        if (executing.size >= poolLimit) {
            await Promise.race(executing);
        }
        
        executePromise(promiseFuncs[i], i).catch(e => {
            // Handle error but continue with other chunks
            console.error(`Chunk ${i} failed:`, e);
        });
    }
    
    await Promise.all(executing);
    return results.filter(Boolean); // Filter out failed chunks
}

async function downloadWithChunks(url, contentLength, chunkSizeMB, concurrentChunks) {
    const chunkSize = chunkSizeMB * 1024 * 1024; // Convert to bytes
    const numChunks = Math.ceil(contentLength / chunkSize);
    
    // Create array of promise-returning functions with progress tracking
    const downloadFunctions = [];
    let totalReceivedBytes = 0;
    
    for (let i = 0; i < numChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize - 1, contentLength - 1);
        
        downloadFunctions.push((progressCallback) => 
            downloadChunk(url, start, end, (bytes) => {
                if (progressCallback) progressCallback(bytes);
            })
        );
    }
    
    const startTime = Date.now();
    let lastBytes = 0;
    let lastTime = startTime;
    
    // Set up progress tracking
    const progressInterval = setInterval(() => {
        const currentTime = Date.now();
        const timeDiff = (currentTime - lastTime) / 1000;
        
        if (timeDiff > 0.5) {
            // Calculate download speed
            const bytesDiff = totalReceivedBytes - lastBytes;
            const speed = bytesDiff / timeDiff;
            
            // Update speed display
            document.getElementById('speed').textContent = formatSize(Math.max(0, speed)) + '/s';
            
            // Calculate and update time remaining
            if (speed > 0) {
                const remainingBytes = contentLength - totalReceivedBytes;
                const timeRemaining = remainingBytes / speed;
                document.getElementById('timeRemaining').textContent = formatTime(timeRemaining);
            } else {
                document.getElementById('timeRemaining').textContent = 'Calculating...';
            }
            
            // Update progress bar and downloaded size display
            const progress = (totalReceivedBytes / contentLength) * 100;
            document.getElementById('progress').style.width = progress + '%';
            document.getElementById('downloadedSize').textContent = formatSize(totalReceivedBytes);
            
            // Update tracking variables
            lastBytes = totalReceivedBytes;
            lastTime = currentTime;
        }
    }, 500);
    
    try {
        // Download chunks with concurrent limit and progress tracking
        const downloadedChunks = await promisePool(
            downloadFunctions, 
            concurrentChunks,
            (bytes) => {
                totalReceivedBytes = bytes;
            }
        );
        
        clearInterval(progressInterval);
        
        // Final progress update
        document.getElementById('progress').style.width = '100%';
        document.getElementById('downloadedSize').textContent = formatSize(contentLength);
        document.getElementById('timeRemaining').textContent = 'Complete';
        
        // Combine chunks
        const blob = new Blob(downloadedChunks, { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        
        return blobUrl;
    } catch (error) {
        clearInterval(progressInterval);
        console.error('Failed to download all chunks:', error);
        throw error;
    }
}

async function startDownload() {
    const url = document.getElementById('urlInput').value.trim();
    if (!url) {
        alert('Vui lòng nhập URL!');
        return;
    }

    // Reset and show the download card
    const downloadCard = document.getElementById('downloadCard');
    downloadCard.style.display = 'block';
    
    // Reset UI elements
    document.getElementById('progress').style.width = '0%';
    document.getElementById('downloadedSize').textContent = '0 MB';
    document.getElementById('speed').textContent = '0 MB/s';
    document.getElementById('timeRemaining').textContent = 'Calculating...';
    document.getElementById('filename').textContent = 'Đang tải...';
    document.getElementById('filesize').textContent = 'Kích thước: ...';

    const encoded = encodeURIComponent(url);
    const useHttp3 = document.getElementById('useHttp3').checked;
    const proxyUrl = `/proxy?url=${encoded}&http3=${useHttp3}`;

    try {
        // Get file information
        const response = await fetch(proxyUrl, { method: 'HEAD' });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const contentLength = parseInt(response.headers.get('content-length') || '0');
        const fileName = response.headers.get('content-disposition')?.split('filename=')[1]?.replace(/"/g, '') || 
                        url.split('/').pop().split('?')[0] || 'file';

        document.getElementById('filename').textContent = fileName;
        document.getElementById('filesize').textContent = 'Kích thước: ' + formatSize(contentLength);

        // Determine download method
        const useChunkedDownload = document.getElementById('chunkDownload').checked && 
                                   contentLength > 5 * 1024 * 1024; // Only use chunks for files > 5MB
        
        if (useChunkedDownload && contentLength) {
            const chunkSizeMB = parseInt(document.getElementById('chunkSize').value) || 5;
            const concurrentChunks = parseInt(document.getElementById('concurrentChunks').value) || 3;
            
            try {
                const blobUrl = await downloadWithChunks(proxyUrl, contentLength, chunkSizeMB, concurrentChunks);
                
                // Trigger download
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = fileName;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                
                // Clean up after download starts
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(blobUrl);
                }, 100);
            } catch (error) {
                console.error('Chunked download failed, falling back to regular download:', error);
                alert('Chunked download failed. Trying direct download...');
                window.open(proxyUrl, '_blank');
            }
        } else {
            // For small files or when chunking is disabled, use direct download
            if (!contentLength) {
                // If content length is unknown, just open in new tab
                window.open(proxyUrl, '_blank');
                return;
            }
            
            // Track download progress for streaming download
            try {
                const response = await fetch(proxyUrl);
                const reader = response.body.getReader();
                let receivedBytes = 0;
                const startTime = Date.now();
                let lastBytes = 0;
                let lastTime = startTime;
                
                while (true) {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        break;
                    }
                    
                    // Update progress
                    receivedBytes += value.length;
                    const progress = (receivedBytes / contentLength) * 100;
                    document.getElementById('progress').style.width = progress + '%';
                    document.getElementById('downloadedSize').textContent = formatSize(receivedBytes);
                    
                    // Update speed and time remaining periodically
                    const currentTime = Date.now();
                    const timeDiff = (currentTime - lastTime) / 1000;
                    
                    if (timeDiff > 0.5) {
                        const bytesDiff = receivedBytes - lastBytes;
                        const speed = bytesDiff / timeDiff;
                        document.getElementById('speed').textContent = formatSize(speed) + '/s';
                        
                        if (speed > 0) {
                            const remainingBytes = contentLength - receivedBytes;
                            const timeRemaining = remainingBytes / speed;
                            document.getElementById('timeRemaining').textContent = formatTime(timeRemaining);
                        }
                        
                        lastBytes = receivedBytes;
                        lastTime = currentTime;
                    }
                }
                
                // Download complete, open in new tab for the actual download
                window.open(proxyUrl, '_blank');
            } catch (error) {
                console.error('Failed to track download progress:', error);
                // Fallback to direct download without progress tracking
                window.open(proxyUrl, '_blank');
            }
        }
    } catch (error) {
        alert('Lỗi khi tải file: ' + error.message);
        console.error('Download error:', error);
    }
}
