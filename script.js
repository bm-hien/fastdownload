// Global tracking variables for downloads
let currentDownload = {
    url: null,
    blobUrl: null,
    fileName: null,
    contentLength: 0,
    receivedBytes: 0,
    chunks: [],
    chunkStatus: [],
    controller: null,
    isPaused: false,
    startTime: null,
    isPending: false,
    activeChunks: new Set(),
    fileType: null,
    serverInfo: null,
    downloadConfig: {
        useChunks: true,
        chunkSize: 5, // MB
        concurrentChunks: 3,
        useHttp3: true
    }
};

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

function formatDate(date) {
    return date.toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });
}

function getFileExtension(filename) {
    return filename.split('.').pop().toLowerCase();
}

function guessFileType(filename, contentType) {
    const ext = getFileExtension(filename);
    const imageTypes = ['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'];
    const videoTypes = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv'];
    const audioTypes = ['mp3', 'wav', 'ogg', 'flac', 'aac'];
    const archiveTypes = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
    const documentTypes = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt'];
    
    if (imageTypes.includes(ext)) return 'Hình ảnh';
    if (videoTypes.includes(ext)) return 'Video';
    if (audioTypes.includes(ext)) return 'Âm thanh';
    if (archiveTypes.includes(ext)) return 'File nén';
    if (documentTypes.includes(ext)) return 'Tài liệu';
    if (ext === 'exe' || ext === 'msi') return 'Ứng dụng';
    if (ext === 'iso') return 'File ISO';
    
    // Use content type as fallback
    if (contentType) {
        if (contentType.startsWith('image/')) return 'Hình ảnh';
        if (contentType.startsWith('video/')) return 'Video';
        if (contentType.startsWith('audio/')) return 'Âm thanh';
        if (contentType.startsWith('application/zip') || 
            contentType.startsWith('application/x-rar') ||
            contentType.startsWith('application/x-7z')) return 'File nén';
        if (contentType.startsWith('application/pdf') ||
            contentType.startsWith('application/msword') ||
            contentType.startsWith('application/vnd.ms-excel')) return 'Tài liệu';
    }
    
    return 'File không xác định';
}

// New function to detect network speed and optimize download settings
async function detectNetworkCapabilities() {
    try {
        // Test connection with a small download to estimate speed
        const testStartTime = Date.now();
        const testResponse = await fetch('/proxy?url=' + encodeURIComponent('https://www.cloudflare.com/favicon.ico'));
        const testData = await testResponse.arrayBuffer();
        const testEndTime = Date.now();
        
        // Calculate speed in MB/s (approximate)
        const testDuration = (testEndTime - testStartTime) / 1000;
        const testSize = testData.byteLength;
        const speedMBps = (testSize / 1024 / 1024) / testDuration;
        
        // Configure download settings based on speed
        const config = {
            useChunks: true,
            useHttp3: true
        };
        
        // Adjust chunk size and concurrency based on network speed
        if (speedMBps < 1) { // Slow connection (< 1 MB/s)
            config.chunkSize = 2;
            config.concurrentChunks = 2;
        } else if (speedMBps < 5) { // Medium connection (1-5 MB/s)
            config.chunkSize = 5;
            config.concurrentChunks = 3;
        } else if (speedMBps < 20) { // Fast connection (5-20 MB/s)
            config.chunkSize = 8;
            config.concurrentChunks = 4;
        } else { // Very fast connection (> 20 MB/s)
            config.chunkSize = 10;
            config.concurrentChunks = 6;
        }
        
        // If connection is extremely slow, disable chunking
        if (speedMBps < 0.3) {
            config.useChunks = false;
        }
        
        return config;
    } catch (error) {
        console.error('Error detecting network capabilities:', error);
        // Return default settings in case of error
        return {
            useChunks: true,
            chunkSize: 5,
            concurrentChunks: 3,
            useHttp3: true
        };
    }
}

function updateDownloadInfo() {
    if (!currentDownload.fileName) return;
    
    document.getElementById('fileType').textContent = currentDownload.fileType || 'Không xác định';
    document.getElementById('serverInfo').textContent = currentDownload.serverInfo || 'Không xác định';
    document.getElementById('startTime').textContent = currentDownload.startTime ? 
        formatDate(currentDownload.startTime) : 'Chưa bắt đầu';
    
    const config = currentDownload.downloadConfig;
    let configText = config.useChunks 
        ? `Tải theo chunks (${config.chunkSize}MB × ${config.concurrentChunks} luồng)`
        : 'Tải trực tiếp';
    configText += config.useHttp3 ? ', HTTP/3' : ', HTTP/2';
    
    document.getElementById('downloadConfig').textContent = configText;
}

async function downloadChunk(url, start, end, chunkIndex, onProgress) {
    if (currentDownload.isPaused) {
        return { paused: true, chunkIndex };
    }
    
    try {
        const controller = new AbortController();
        currentDownload.activeChunks.add(controller);
        
        const response = await fetch(url, {
            headers: {
                'Range': `bytes=${start}-${end}`
            },
            signal: controller.signal
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        // Store server info if not already captured
        if (!currentDownload.serverInfo) {
            const server = response.headers.get('server') || response.headers.get('via');
            currentDownload.serverInfo = server || 'CloudFlare';
        }
        
        // Get content type if not already determined
        if (!currentDownload.fileType) {
            const contentType = response.headers.get('content-type');
            currentDownload.fileType = guessFileType(currentDownload.fileName, contentType);
        }
        
        const contentLength = parseInt(response.headers.get('Content-Length') || '0');
        const reader = response.body.getReader();
        const chunks = [];
        let receivedLength = 0;
        
        while (true) {
            if (currentDownload.isPaused) {
                reader.cancel();
                currentDownload.activeChunks.delete(controller);
                return { paused: true, chunkIndex };
            }
            
            const { done, value } = await reader.read();
            if (done) break;
            
            chunks.push(value);
            receivedLength += value.length;
            
            // Report progress
            if (onProgress) {
                onProgress(value.length, receivedLength);
            }
        }
        
        // Concatenate chunks
        let chunksAll = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
            chunksAll.set(chunk, position);
            position += chunk.length;
        }
        
        currentDownload.chunkStatus[chunkIndex] = 'complete';
        currentDownload.chunks[chunkIndex] = chunksAll.buffer;
        currentDownload.activeChunks.delete(controller);
        
        updateDownloadInfo();
        return chunksAll.buffer;
    } catch (error) {
        if (error.name === 'AbortError') {
            return { aborted: true, chunkIndex };
        }
        console.error('Error downloading chunk:', error);
        currentDownload.chunkStatus[chunkIndex] = 'error';
        updateDownloadInfo();
        throw error;
    }
}

async function promisePool(promiseFuncs, poolLimit, onProgress) {
    const results = new Array(promiseFuncs.length);
    const executing = new Set();
    let completedBytes = 0;
    
    const enqueue = async function(index) {
        // Check if download was paused or cancelled
        if (currentDownload.isPaused) {
            return { paused: true };
        }
        
        // Create a promise for the current task
        const promiseFunc = promiseFuncs[index];
        const promise = promiseFunc((bytes, totalChunkBytes) => {
            completedBytes += bytes;
            if (onProgress) {
                onProgress(completedBytes, index, totalChunkBytes);
            }
        });
        
        // Add to tracking set
        executing.add(promise);
        
        try {
            const result = await promise;
            results[index] = result;
        } catch (error) {
            results[index] = null;
            console.error(`Error in download chunk ${index}:`, error);
        } finally {
            executing.delete(promise);
            
            // If we're not paused, add the next task
            if (!currentDownload.isPaused && promiseFuncs.length > index + poolLimit) {
                enqueue(index + poolLimit);
            }
        }
    };
    
    // Initial population of the pool
    const initialCount = Math.min(poolLimit, promiseFuncs.length);
    for (let i = 0; i < initialCount; i++) {
        enqueue(i);
    }
    
    // Wait for all executing promises to complete
    await Promise.all(executing);
    
    return results.filter(result => result !== null && !result.aborted && !result.paused);
}

async function downloadWithChunks(url, contentLength, chunkSizeMB, concurrentChunks) {
    const chunkSize = chunkSizeMB * 1024 * 1024; // Convert to bytes
    const numChunks = Math.ceil(contentLength / chunkSize);
    
    // Initialize chunk status tracking
    currentDownload.chunkStatus = new Array(numChunks).fill('pending');
    currentDownload.chunks = new Array(numChunks).fill(null);
    
    // Create array of promise-returning functions with progress tracking
    const downloadFunctions = [];
    
    for (let i = 0; i < numChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize - 1, contentLength - 1);
        
        downloadFunctions.push((progressCallback) => 
            downloadChunk(url, start, end, i, (bytes, totalChunkBytes) => {
                if (progressCallback) progressCallback(bytes, totalChunkBytes);
            })
        );
    }
    
    // Set up progress tracking
    const progressInterval = setInterval(() => {
        if (currentDownload.isPaused) return;
        
        const currentTime = Date.now();
        const totalTime = (currentTime - currentDownload.startTime) / 1000; // in seconds
        
        if (totalTime > 0) {
            // Calculate download speed based on total received bytes and elapsed time
            const speed = currentDownload.receivedBytes / totalTime;
            
            // Update speed display
            document.getElementById('speed').textContent = formatSize(Math.max(0, speed)) + '/s';
            
            // Calculate and update time remaining
            if (speed > 0) {
                const remainingBytes = contentLength - currentDownload.receivedBytes;
                const timeRemaining = remainingBytes / speed;
                document.getElementById('timeRemaining').textContent = formatTime(timeRemaining);
            } else {
                document.getElementById('timeRemaining').textContent = 'Calculating...';
            }
        }
        
        // Update progress bar and downloaded size display
        const progress = (currentDownload.receivedBytes / contentLength) * 100;
        document.getElementById('progress').style.width = progress + '%';
        document.getElementById('downloadedSize').textContent = formatSize(currentDownload.receivedBytes);
        
        // Update download info
        updateDownloadInfo();
    }, 500);
    
    try {
        // Download chunks with concurrent limit and progress tracking
        const downloadedChunks = await promisePool(
            downloadFunctions, 
            concurrentChunks,
            (bytes, chunkIndex, totalChunkBytes) => {
                currentDownload.receivedBytes += bytes;
            }
        );
        
        // If download was paused, return null
        if (currentDownload.isPaused) {
            return null;
        }
        
        clearInterval(progressInterval);
        
        // Final progress update
        document.getElementById('progress').style.width = '100%';
        document.getElementById('downloadedSize').textContent = formatSize(contentLength);
        document.getElementById('timeRemaining').textContent = 'Complete';
        
        // Combine chunks
        const blob = new Blob(downloadedChunks, { type: 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        
        // Store the blob URL for later use
        currentDownload.blobUrl = blobUrl;
        
        return blobUrl;
    } catch (error) {
        clearInterval(progressInterval);
        console.error('Failed to download all chunks:', error);
        throw error;
    }
}

function pauseDownload() {
    if (!currentDownload.url || currentDownload.isPaused) return;
    
    currentDownload.isPaused = true;
    document.getElementById('pauseButton').disabled = true;
    document.getElementById('resumeButton').disabled = false;
    document.getElementById('progress').classList.add('paused');
    document.getElementById('timeRemaining').textContent = 'Tạm dừng';
    
    // Abort any active fetch operations
    currentDownload.activeChunks.forEach(controller => {
        try {
            controller.abort();
        } catch (e) {
            console.error('Error aborting download:', e);
        }
    });
}

async function resumeDownload() {
    if (!currentDownload.url || !currentDownload.isPaused) return;
    
    currentDownload.isPaused = false;
    document.getElementById('pauseButton').disabled = false;
    document.getElementById('resumeButton').disabled = true;
    document.getElementById('progress').classList.remove('paused');
    
    // Create new start time that accounts for elapsed time
    const elapsedMs = Date.now() - currentDownload.startTime.getTime();
    currentDownload.startTime = new Date(Date.now() - elapsedMs);
    
    // Resume download using current configuration
    try {
        // Start from scratch with the same parameters
        const url = currentDownload.url;
        const encoded = encodeURIComponent(url);
        const config = currentDownload.downloadConfig;
        const proxyUrl = `/proxy?url=${encoded}&http3=${config.useHttp3}`;
        
        // Note: in a real implementation, we would track which chunks were completed
        // and only download the missing ones. This simplification restarts the download.
        const blobUrl = await downloadWithChunks(
            proxyUrl, 
            currentDownload.contentLength, 
            config.chunkSize, 
            config.concurrentChunks
        );
        
        if (blobUrl) {
            currentDownload.blobUrl = blobUrl;
            document.getElementById('saveButton').disabled = false;
        }
    } catch (error) {
        console.error('Failed to resume download:', error);
        alert('Lỗi khi tiếp tục tải: ' + error.message);
    }
}

function cancelDownload() {
    if (!currentDownload.url) return;
    
    // Abort any active fetch operations
    currentDownload.activeChunks.forEach(controller => {
        try {
            controller.abort();
        } catch (e) {
            console.error('Error aborting download:', e);
        }
    });
    
    // Clean up blob URL if it exists
    if (currentDownload.blobUrl) {
        try {
            URL.revokeObjectURL(currentDownload.blobUrl);
        } catch (e) {
            console.error('Error revoking blob URL:', e);
        }
    }
    
    // Reset UI
    document.getElementById('progress').style.width = '0%';
    document.getElementById('progress').classList.remove('paused');
    document.getElementById('downloadedSize').textContent = '0 MB';
    document.getElementById('speed').textContent = '0 MB/s';
    document.getElementById('timeRemaining').textContent = '--:--';
    document.getElementById('pauseButton').disabled = false;
    document.getElementById('resumeButton').disabled = true;
    document.getElementById('saveButton').disabled = false;
    
    // Reset download state
    currentDownload = {
        url: null,
        blobUrl: null,
        fileName: null,
        contentLength: 0,
        receivedBytes: 0,
        chunks: [],
        chunkStatus: [],
        controller: null,
        isPaused: false,
        startTime: null,
        isPending: false,
        activeChunks: new Set(),
        fileType: null,
        serverInfo: null,
        downloadConfig: {
            useChunks: true,
            chunkSize: 5,
            concurrentChunks: 3,
            useHttp3: true
        }
    };
}

function saveDownload() {
    if (!currentDownload.blobUrl || !currentDownload.fileName) {
        alert('Không có file để lưu hoặc quá trình tải chưa hoàn tất!');
        return;
    }
    
    const a = document.createElement('a');
    a.href = currentDownload.blobUrl;
    a.download = currentDownload.fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function startDownload() {
    const url = document.getElementById('urlInput').value.trim();
    if (!url) {
        alert('Vui lòng nhập URL!');
        return;
    }
    
    // Cancel any existing download
    if (currentDownload.url) {
        if (!confirm('Đã có tải xuống đang diễn ra. Bạn muốn hủy và bắt đầu tải xuống mới?')) {
            return;
        }
        cancelDownload();
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
    document.getElementById('fileType').textContent = '...';
    document.getElementById('serverInfo').textContent = '...';
    document.getElementById('startTime').textContent = '...';
    document.getElementById('downloadConfig').textContent = 'Đang phân tích...';
    document.getElementById('pauseButton').disabled = false;
    document.getElementById('resumeButton').disabled = true;
    document.getElementById('saveButton').disabled = true;

    try {
        // Detect network capabilities and optimize download settings
        const networkConfig = await detectNetworkCapabilities();
        
        // Initialize download state
        currentDownload.url = url;
        currentDownload.startTime = new Date();
        currentDownload.isPaused = false;
        currentDownload.receivedBytes = 0;
        currentDownload.downloadConfig = networkConfig;
        
        const encoded = encodeURIComponent(url);
        const useHttp3 = networkConfig.useHttp3;
        const proxyUrl = `/proxy?url=${encoded}&http3=${useHttp3}`;

        // Get file information
        const response = await fetch(proxyUrl, { method: 'HEAD' });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const contentLength = parseInt(response.headers.get('content-length') || '0');
        const fileName = response.headers.get('content-disposition')?.split('filename=')[1]?.replace(/"/g, '') || 
                        url.split('/').pop().split('?')[0] || 'file';
        
        currentDownload.fileName = fileName;
        currentDownload.contentLength = contentLength;
        currentDownload.fileType = guessFileType(fileName, response.headers.get('content-type'));
        currentDownload.serverInfo = response.headers.get('server') || response.headers.get('via') || 'CloudFlare';
        
        document.getElementById('filename').textContent = fileName;
        document.getElementById('filesize').textContent = 'Kích thước: ' + formatSize(contentLength);
        
        updateDownloadInfo();

        // Determine if we should use chunked download based on file size and network capabilities
        const useChunkedDownload = networkConfig.useChunks && contentLength > 5 * 1024 * 1024; // Only use chunks for files > 5MB
        
        if (useChunkedDownload && contentLength) {
            try {
                // Start chunked download with progress tracking
                const blobUrl = await downloadWithChunks(
                    proxyUrl, 
                    contentLength, 
                    networkConfig.chunkSize, 
                    networkConfig.concurrentChunks
                );
                
                if (blobUrl) {
                    currentDownload.blobUrl = blobUrl;
                    document.getElementById('saveButton').disabled = false;
                }
            } catch (error) {
                if (!currentDownload.isPaused) {
                    console.error('Chunked download failed, falling back to regular download:', error);
                    
                    // Update config to reflect the change to direct download
                    currentDownload.downloadConfig.useChunks = false;
                    updateDownloadInfo();
                    
                    alert('Chunked download failed. Trying direct download...');
                    window.open(proxyUrl, '_blank');
                }
            }
        } else {
            // Update config to reflect direct download
            currentDownload.downloadConfig.useChunks = false;
            updateDownloadInfo();
            
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
                
                while (true) {
                    if (currentDownload.isPaused) {
                        reader.cancel();
                        break;
                    }
                    
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        break;
                    }
                    
                    // Update progress
                    receivedBytes += value.length;
                    currentDownload.receivedBytes = receivedBytes;
                    const progress = (receivedBytes / contentLength) * 100;
                    document.getElementById('progress').style.width = progress + '%';
                    document.getElementById('downloadedSize').textContent = formatSize(receivedBytes);
                }
                
                if (!currentDownload.isPaused) {
                    // Download complete, trigger download
                    window.open(proxyUrl, '_blank');
                }
            } catch (error) {
                if (!currentDownload.isPaused) {
                    console.error('Failed to track download progress:', error);
                    // Fallback to direct download without progress tracking
                    window.open(proxyUrl, '_blank');
                }
            }
        }
    } catch (error) {
        alert('Lỗi khi tải file: ' + error.message);
        console.error('Download error:', error);
    }
}

// Initialize UI when page loads
document.addEventListener('DOMContentLoaded', function() {
    // Reset buttons to initial state
    document.getElementById('pauseButton').disabled = false;
    document.getElementById('resumeButton').disabled = true;
    document.getElementById('saveButton').disabled = true;
});
